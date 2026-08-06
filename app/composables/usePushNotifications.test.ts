import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { derivePushNotificationState, usePushNotifications } from "./usePushNotifications";

describe("push notification lifecycle states", () => {
  it("covers unsupported, unavailable, permission, and active states", () => {
    expect(derivePushNotificationState({ supported: false, available: false, permission: "default", backendActive: false, browserHasSubscription: false })).toBe("unsupported");
    expect(derivePushNotificationState({ supported: true, available: false, permission: "default", backendActive: false, browserHasSubscription: false })).toBe("unavailable");
    expect(derivePushNotificationState({ supported: true, available: true, permission: "default", backendActive: false, browserHasSubscription: false })).toBe("permission-default");
    expect(derivePushNotificationState({ supported: true, available: true, permission: "denied", backendActive: false, browserHasSubscription: false })).toBe("permission-denied");
    expect(derivePushNotificationState({ supported: true, available: true, permission: "granted", backendActive: false, browserHasSubscription: true })).toBe("permission-granted-unsubscribed");
    expect(derivePushNotificationState({ supported: true, available: true, permission: "granted", backendActive: true, browserHasSubscription: true })).toBe("active");
  });

  it("prioritizes explicit operations", () => {
    const base = { supported: true, available: true, permission: "granted" as const, backendActive: true, browserHasSubscription: true };
    expect(derivePushNotificationState({ ...base, operation: "registering" })).toBe("registering");
    expect(derivePushNotificationState({ ...base, operation: "unregistering" })).toBe("unregistering");
  });
});

type BrowserHarness = {
  notification: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  subscription: { endpoint: string; toJSON: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
};

function makeBrowserHarness(existing = false): BrowserHarness {
  const subscription = {
    endpoint: "https://push.example/current",
    toJSON: vi.fn(() => ({ endpoint: "https://push.example/current", keys: { p256dh: "public", auth: "secret" }, expirationTime: null })),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const getSubscription = vi.fn().mockResolvedValue(existing ? subscription : null);
  const subscribe = vi.fn().mockImplementation(async () => {
    getSubscription.mockResolvedValue(subscription);
    return subscription;
  });
  const notification = { permission: "default" as NotificationPermission, requestPermission: vi.fn() };
  notification.requestPermission.mockImplementation(async () => {
    notification.permission = "granted";
    return "granted";
  });
  const fetch = vi.fn(async (url: string, options?: any) => {
    if (url === "/api/notifications/status") {
      return { enabled: true, activeCount: 1, currentEndpointActive: existing || true, scheduleSlot: "MORNING", allowBreakingNotifications: true };
    }
    return { ok: true };
  });
  const registration = { pushManager: { getSubscription, subscribe } };
  vi.stubGlobal("window", { PushManager: class PushManager {}, console });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("useRuntimeConfig", () => ({ public: { vapidPublicKey: "AQIDBAUGBwgJCgsMDQ4PEA" } }));
  vi.stubGlobal("$fetch", fetch);
  return { notification, subscription, getSubscription, subscribe, fetch, requestPermission: notification.requestPermission };
}

describe("usePushNotifications behavioral lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports unsupported and missing VAPID without requesting permission", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    vi.stubGlobal("useRuntimeConfig", () => ({ public: { vapidPublicKey: "" } }));
    vi.stubGlobal("$fetch", vi.fn());
    const push = usePushNotifications();
    await push.refreshStatus();
    expect(push.state.value).toBe("unsupported");
    expect((Notification.requestPermission as any)).not.toHaveBeenCalled();

    const harness = makeBrowserHarness();
    vi.stubGlobal("useRuntimeConfig", () => ({ public: { vapidPublicKey: "" } }));
    const unavailable = usePushNotifications();
    await unavailable.subscribe();
    expect(unavailable.state.value).toBe("unavailable");
    expect(harness.requestPermission).not.toHaveBeenCalled();
  });

  it("passive refresh never requests permission", async () => {
    const harness = makeBrowserHarness(false);
    const push = usePushNotifications();
    await push.refreshStatus();
    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(push.state.value).toBe("permission-default");
  });

  it("requests permission only after explicit enable and registers a new subscription", async () => {
    const harness = makeBrowserHarness(false);
    const push = usePushNotifications();
    expect(harness.requestPermission).not.toHaveBeenCalled();
    const result = await push.subscribe();
    expect(result).toBe(true);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledWith("/api/notifications/subscribe", expect.objectContaining({ method: "POST" }));
    expect(push.state.value).toBe("active");
  });

  it("does not request permission when already denied and keeps denied authoritative", async () => {
    const harness = makeBrowserHarness(false);
    harness.notification.permission = "denied";
    const push = usePushNotifications();
    const result = await push.subscribe();
    expect(result).toBe(false);
    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(push.state.value).toBe("permission-denied");
    await push.refreshStatus();
    expect(push.state.value).toBe("permission-denied");
  });

  it("keeps permission-default when the user dismisses the permission prompt", async () => {
    const harness = makeBrowserHarness(false);
    harness.requestPermission.mockResolvedValueOnce("default");
    const push = usePushNotifications();
    expect(await push.subscribe()).toBe(false);
    expect(push.state.value).toBe("permission-default");
  });

  it("reuses and re-persists an existing browser subscription", async () => {
    const harness = makeBrowserHarness(true);
    const push = usePushNotifications();
    expect(await push.subscribe()).toBe(true);
    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledWith("/api/notifications/subscribe", expect.objectContaining({ method: "POST" }));
  });

  it("returns recoverable error after backend persistence failure and can retry", async () => {
    const harness = makeBrowserHarness(false);
    harness.fetch.mockImplementationOnce(async (url: string) => {
      if (url === "/api/notifications/subscribe") throw new Error("persistence unavailable");
      return { enabled: true, activeCount: 1, currentEndpointActive: true, scheduleSlot: "MORNING", allowBreakingNotifications: true };
    });
    const push = usePushNotifications();
    expect(await push.subscribe()).toBe(false);
    expect(push.state.value).toBe("recoverable-error");
    harness.fetch.mockImplementation(async (url: string) => url === "/api/notifications/status"
      ? { enabled: true, activeCount: 1, currentEndpointActive: true, scheduleSlot: "MORNING", allowBreakingNotifications: true }
      : { ok: true });
    expect(await push.subscribe()).toBe(true);
    expect(push.state.value).toBe("active");
  });

  it("disables only the current endpoint and handles backend/browser unsubscribe failures", async () => {
    const harness = makeBrowserHarness(true);
    const push = usePushNotifications();
    await push.unsubscribe();
    expect(harness.fetch).toHaveBeenCalledWith("/api/notifications/unsubscribe", expect.objectContaining({ body: { endpoint: "https://push.example/current" } }));
    expect(harness.subscription.unsubscribe).toHaveBeenCalledTimes(1);

    const backendFailure = makeBrowserHarness(true);
    backendFailure.fetch.mockRejectedValueOnce(new Error("unsubscribe backend failed"));
    const failingBackend = usePushNotifications();
    expect(await failingBackend.unsubscribe()).toBe(false);
    expect(backendFailure.subscription.unsubscribe).not.toHaveBeenCalled();

    const browserFailure = makeBrowserHarness(true);
    browserFailure.subscription.unsubscribe.mockRejectedValueOnce(new Error("browser unsubscribe failed"));
    const failingBrowser = usePushNotifications();
    expect(await failingBrowser.unsubscribe()).toBe(false);
  });

  it("shows active when permission changes externally and Refresh confirms persistence", async () => {
    const harness = makeBrowserHarness(true);
    harness.notification.permission = "default";
    const push = usePushNotifications();
    await push.refreshStatus();
    expect(push.state.value).toBe("permission-default");
    harness.notification.permission = "granted";
    await push.refreshStatus();
    expect(push.state.value).toBe("active");
  });

  it("does not log endpoints, keys, payloads, or VAPID material", async () => {
    const harness = makeBrowserHarness(true);
    const log = vi.spyOn(console, "log");
    const debug = vi.spyOn(console, "debug");
    const info = vi.spyOn(console, "info");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const push = usePushNotifications();
    await push.subscribe();
    const output = JSON.stringify([log.mock.calls, debug.mock.calls, info.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(output).not.toContain("push.example/current");
    expect(output).not.toContain("public");
    expect(output).not.toContain("secret");
    expect(harness.subscription.toJSON).toHaveBeenCalled();
  });
});
