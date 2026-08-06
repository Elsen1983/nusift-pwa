import { computed, ref } from "vue";

type PushPermissionState = "default" | "granted" | "denied";
type NotificationSlot = "MORNING" | "NOON" | "EVENING";
export type PushNotificationState =
  | "unsupported"
  | "unavailable"
  | "permission-default"
  | "permission-granted-unsubscribed"
  | "active"
  | "permission-denied"
  | "registering"
  | "unregistering"
  | "recoverable-error";

export function derivePushNotificationState(input: {
  supported: boolean;
  available: boolean;
  permission: PushPermissionState;
  backendActive: boolean;
  browserHasSubscription: boolean;
  operation?: "idle" | "registering" | "unregistering";
}): PushNotificationState {
  if (input.operation === "registering") return "registering";
  if (input.operation === "unregistering") return "unregistering";
  if (!input.supported) return "unsupported";
  if (!input.available) return "unavailable";
  if (input.permission === "denied") return "permission-denied";
  if (input.permission === "default") return "permission-default";
  if (input.browserHasSubscription && input.backendActive) return "active";
  return "permission-granted-unsubscribed";
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function browserPermission(): PushPermissionState {    if (typeof window === "undefined" || typeof Notification === "undefined") return "default";
  return Notification.permission as PushPermissionState;
}

/**
 * The single browser push lifecycle. Refreshing status never asks for
 * permission and never creates/persists a subscription; activation is explicit.
 */
export function usePushNotifications() {
  const config = useRuntimeConfig();
  const state = ref<PushNotificationState>("permission-default");
  const operation = ref<"idle" | "registering" | "unregistering">("idle");
  const error = ref<string | null>(null);
  const permission = ref<PushPermissionState>("default");
  const enabled = ref(false);
  const activeCount = ref(0);
  const browserSubscriptionPersisted = ref(false);
  const scheduleSlot = ref<NotificationSlot>("MORNING");
  const breakingEnabled = ref(true);
  const publicKey = computed(() => config.public.vapidPublicKey || "");

  const supported = computed(() => typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof Notification !== "undefined" &&
    "PushManager" in window);
  const available = computed(() => supported.value && Boolean(publicKey.value));

  const updatePassiveState = (backendActive: boolean, browserHasSubscription: boolean) => {
    permission.value = browserPermission();
    enabled.value = backendActive && browserHasSubscription;
    browserSubscriptionPersisted.value = backendActive && browserHasSubscription;
    state.value = derivePushNotificationState({
      supported: supported.value,
      available: available.value,
      permission: permission.value,
      backendActive,
      browserHasSubscription,
      operation: operation.value,
    });
  };

  const ensureServiceWorker = async () => {
    if (!supported.value) throw new Error("Push notifications are not supported in this browser.");
    return navigator.serviceWorker.ready;
  };

  const getBrowserSubscription = async () => {
    const registration = await ensureServiceWorker();
    return { registration, subscription: await registration.pushManager.getSubscription() };
  };

  /** Status uses the current endpoint only as an authenticated request input. */
  const refreshStatus = async () => {
    if (typeof window === "undefined") return;
    permission.value = browserPermission();
    if (!supported.value) {
      updatePassiveState(false, false);
      return;
    }
    if (!available.value) {
      updatePassiveState(false, false);
      return;
    }
    try {
      const { subscription } = await getBrowserSubscription();
      const response = await $fetch<{
        enabled: boolean;
        activeCount: number;
        currentEndpointActive: boolean;
        scheduleSlot?: NotificationSlot;
        allowBreakingNotifications?: boolean;
      }>("/api/notifications/status", {
        method: "POST",
        body: { currentEndpoint: subscription?.endpoint || null },
      });
      activeCount.value = response.activeCount || 0;
      scheduleSlot.value = response.scheduleSlot || "MORNING";
      breakingEnabled.value = response.allowBreakingNotifications ?? true;
      updatePassiveState(Boolean(response.currentEndpointActive), Boolean(subscription));
    } catch (err: any) {
      permission.value = browserPermission();
      state.value = permission.value === "denied" ? "permission-denied" : "recoverable-error";
      error.value = err?.data?.statusMessage || err?.message || "Unable to refresh notification status.";
    }
  };

  const persistBrowserSubscription = async (subscription: PushSubscription) => {
    await $fetch("/api/notifications/subscribe", {
      method: "POST",
      body: subscription.toJSON(),
    });
  };

  /** Must only be called from an explicit user action. */
  const subscribe = async () => {
    if (typeof window === "undefined") return false;
    let completed = false;
    operation.value = "registering";
    state.value = "registering";
    error.value = null;
    try {
      if (!supported.value) {
        state.value = "unsupported";
        throw new Error("Push notifications are not supported in this browser.");
      }
      if (!publicKey.value) {
        state.value = "unavailable";
        throw new Error("Browser notification setup is unavailable right now.");
      }
      permission.value = browserPermission();
      if (permission.value === "denied") {
        state.value = "permission-denied";
        error.value = "Notification permission was denied.";
        return false;
      }
      const { registration, subscription: existing } = await getBrowserSubscription();
      const granted = await Notification.requestPermission();
      permission.value = granted as PushPermissionState;
      if (granted !== "granted") {
        state.value = granted === "denied" ? "permission-denied" : "permission-default";
        error.value = granted === "denied" ? "Notification permission was denied." : null;
        return false;
      }
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey.value),
      });
      await persistBrowserSubscription(subscription);
      await refreshStatus();
      if (!enabled.value || !browserSubscriptionPersisted.value) {
        throw new Error("The browser subscription could not be confirmed by the server.");
      }
      completed = true;
      return true;
    } catch (err: any) {
      permission.value = browserPermission();
      if (permission.value === "denied") state.value = "permission-denied";
      else if (state.value !== "unsupported" && state.value !== "unavailable") state.value = "recoverable-error";
      error.value = err?.data?.statusMessage || err?.message || "Unable to enable browser notifications.";
      return false;
    } finally {
      operation.value = "idle";
      if (completed) updatePassiveState(true, true);
      else if (permission.value === "denied") state.value = "permission-denied";
      else if (state.value === "registering") state.value = "recoverable-error";
    }
  };

  const unsubscribe = async () => {
    if (typeof window === "undefined") return false;
    operation.value = "unregistering";
    state.value = "unregistering";
    error.value = null;
    try {
      if (!supported.value) throw new Error("Push notifications are not supported in this browser.");
      const { subscription } = await getBrowserSubscription();
      if (subscription) {
        await $fetch("/api/notifications/unsubscribe", {
          method: "POST",
          body: { endpoint: subscription.endpoint },
        });
        await subscription.unsubscribe();
      }
      await refreshStatus();
      return true;
    } catch (err: any) {
      permission.value = browserPermission();
      state.value = permission.value === "denied" ? "permission-denied" : "recoverable-error";
      error.value = err?.data?.statusMessage || err?.message || "Unable to disable browser notifications.";
      return false;
    } finally {
      operation.value = "idle";
      if (state.value === "unregistering") state.value = "permission-granted-unsubscribed";
    }
  };

  const setScheduleSlot = async (slot: NotificationSlot) => {
    scheduleSlot.value = slot;
    await $fetch("/api/user/notifications-preference", {
      method: "PUT",
      body: { scheduleSlot: slot, allowBreakingNotifications: breakingEnabled.value },
    });
  };

  const setBreakingEnabled = async (value: boolean) => {
    breakingEnabled.value = value;
    await $fetch("/api/user/notifications-preference", {
      method: "PUT",
      body: { scheduleSlot: scheduleSlot.value, allowBreakingNotifications: value },
    });
  };

  return {
    state,
    operation,
    status: state,
    error,
    permission,
    enabled,
    activeCount,
    browserSubscriptionPersisted,
    supported,
    available,
    scheduleSlot,
    breakingEnabled,
    refreshStatus,
    subscribe,
    unsubscribe,
    setScheduleSlot,
    setBreakingEnabled,
  };
}
