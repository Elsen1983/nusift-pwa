import { computed, ref } from "vue";

type PushPermissionState = "default" | "granted" | "denied";
type NotificationSlot = "MORNING" | "NOON" | "EVENING";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export function usePushNotifications() {
  const config = useRuntimeConfig();
  const status = ref<"idle" | "loading" | "ready" | "error">("idle");
  const error = ref<string | null>(null);
  const permission = ref<PushPermissionState>("default");
  const enabled = ref(false);
  const activeCount = ref(0);
  const scheduleSlot = ref<NotificationSlot>("MORNING");
  const breakingEnabled = ref(true);

  const publicKey = computed(() => config.public.vapidPublicKey || "");

  const refreshStatus = async () => {
    if (!import.meta.client) return;
    const response: any = await $fetch("/api/notifications/status");
    enabled.value = Boolean(response.enabled);
    activeCount.value = response.activeCount || 0;
    scheduleSlot.value = response.scheduleSlot || "MORNING";
    breakingEnabled.value = response.allowBreakingNotifications ?? true;
    permission.value = Notification.permission as PushPermissionState;
  };

  const ensureServiceWorker = async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service worker is not supported in this browser.");
    }
    return navigator.serviceWorker.ready;
  };

  const subscribe = async () => {
    try {
      status.value = "loading";
      error.value = null;

      if (!publicKey.value) {
        throw new Error("VAPID public key is missing.");
      }

      const swRegistration = await ensureServiceWorker();
      const granted = await Notification.requestPermission();
      permission.value = granted as PushPermissionState;
      if (granted !== "granted") {
        throw new Error("Notification permission was not granted.");
      }

      const existing = await swRegistration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey.value),
        }));

      await $fetch("/api/notifications/subscribe", {
        method: "POST",
        body: subscription.toJSON(),
      });

      await refreshStatus();
      status.value = "ready";
      return true;
    } catch (err: any) {
      status.value = "error";
      error.value = err?.message || "Unable to enable notifications.";
      return false;
    }
  };

  const unsubscribe = async () => {
    try {
      status.value = "loading";
      error.value = null;
      const swRegistration = await ensureServiceWorker();
      const subscription = await swRegistration.pushManager.getSubscription();
      if (subscription) {
        await $fetch("/api/notifications/unsubscribe", {
          method: "POST",
          body: { endpoint: subscription.endpoint },
        });
        await subscription.unsubscribe();
      }
      await refreshStatus();
      status.value = "ready";
      return true;
    } catch (err: any) {
      status.value = "error";
      error.value = err?.message || "Unable to disable notifications.";
      return false;
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
    status,
    error,
    permission,
    enabled,
    activeCount,
    scheduleSlot,
    breakingEnabled,
    refreshStatus,
    subscribe,
    unsubscribe,
    setScheduleSlot,
    setBreakingEnabled,
  };
}
