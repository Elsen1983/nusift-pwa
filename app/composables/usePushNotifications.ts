// app/composables/usePushNotifications.ts

// ANCHOR imports
import { computed, ref } from "vue";

type PushPermissionState = "default" | "granted" | "denied";
type NotificationSlot = "MORNING" | "NOON" | "EVENING";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// ANCHOR usePushNotifications()
/**
 * Vue composition function for managing push notifications.
 *
 * This module provides functionality to:
 * - Check notification permissions
 * - Subscribe/unsubscribe from push notifications
 * - Manage notification preferences (schedule slots and breaking news)
 * - Handle service worker registration
 *
 * @returns An object containing reactive state and methods for push notification management
 */
export function usePushNotifications() {
  const config = useRuntimeConfig();
  // State management using Vue's reactivity system
  const status = ref<"idle" | "loading" | "ready" | "error">("idle"); // Tracks the current operation state
  const error = ref<string | null>(null); // Stores any error messages that occur
  const permission = ref<PushPermissionState>("default"); // Current notification permission state
  const enabled = ref(false); // Whether notifications are currently enabled for this user
  const activeCount = ref(0); // Number of active notification subscriptions
  const scheduleSlot = ref<NotificationSlot>("MORNING"); // Preferred time slot for scheduled notifications
  const breakingEnabled = ref(true); // Whether to allow breaking news notifications

  /**
   * Computed property that extracts the VAPID public key from runtime config.
   * Used for encrypting push messages between server and client.
   */
  const publicKey = computed(() => config.public.vapidPublicKey || "");

  /**
   * Refreshes the notification state by fetching current settings from the server.
   * Should be called after any subscription changes or when component mounts.
   */
  const refreshStatus = async () => {
    if (!import.meta.client) return; // Skip on server-side rendering
    try {
      const response: any = await $fetch("/api/notifications/status");
      enabled.value = Boolean(response.enabled);
      activeCount.value = response.activeCount || 0;
      scheduleSlot.value = response.scheduleSlot || "MORNING";
      breakingEnabled.value = response.allowBreakingNotifications ?? true;
      permission.value = Notification.permission as PushPermissionState;
    } catch (err) {
      console.error("Failed to refresh notification status:", err);
      // Error handling could be improved here
    }
  };

  /**
   * Ensures the service worker is registered and ready.
   *
   * @throws {Error} If service workers are not supported in the browser
   * @returns Promise that resolves with the ServiceWorkerRegistration object
   */
  const ensureServiceWorker = async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service worker is not supported in this browser.");
    }
    return navigator.serviceWorker.ready;
  };

  // ANCHOR subscribe()
  /**
   * Subscribes the user to push notifications.
   *
   * @returns Promise that resolves with true on success, false on failure
   */
  const subscribe = async () => {
    try {
      status.value = "loading";
      error.value = null;

      if (!publicKey.value) {
        throw new Error("VAPID public key is missing.");
      }

      // Get service worker registration and request permission
      const swRegistration = await ensureServiceWorker();
      const granted = await Notification.requestPermission();
      permission.value = granted as PushPermissionState;
      if (granted !== "granted") {
        throw new Error("Notification permission was not granted.");
      }

      // Create or get existing subscription
      const existing = await swRegistration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey.value),
        }));

      // Send subscription details to server for storage
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

  // ANCHOR unsubscribe()
  /**
   * Unsubscribes the user from push notifications.
   *
   * @returns Promise that resolves with true on success, false on failure
   */
  const unsubscribe = async () => {
    try {
      status.value = "loading";
      error.value = null;

      // Get service worker registration and current subscription
      const swRegistration = await ensureServiceWorker();
      const subscription = await swRegistration.pushManager.getSubscription();
      if (subscription) {
        // Notify server to remove the subscription from database
        await $fetch("/api/notifications/unsubscribe", {
          method: "POST",
          body: { endpoint: subscription.endpoint },
        });
        // Remove the subscription from browser
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

  // ANCHOR setScheduleSlot()
  /**
   * Updates the preferred notification schedule slot.
   *
   * @param slot - The time slot for scheduled notifications ("MORNING", "NOON", or "EVENING")
   */
  const setScheduleSlot = async (slot: NotificationSlot) => {
    scheduleSlot.value = slot;
    await $fetch("/api/user/notifications-preference", {
      method: "PUT",
      body: {
        scheduleSlot: slot,
        allowBreakingNotifications: breakingEnabled.value,
      },
    });
  };

  // ANCHOR setBreakingEnabled()
  /**
   * Updates the preference for receiving breaking news notifications.
   *
   * @param value - Whether to allow breaking news notifications
   */
  const setBreakingEnabled = async (value: boolean) => {
    breakingEnabled.value = value;
    await $fetch("/api/user/notifications-preference", {
      method: "PUT",
      body: {
        scheduleSlot: scheduleSlot.value,
        allowBreakingNotifications: value,
      },
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
