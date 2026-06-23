import { watch } from "vue";
import { useAuthStore } from "~/stores/auth";

export default defineNuxtPlugin((nuxtApp) => {
  const authStore = useAuthStore();
  const unreadNotificationCount = useState<number>(
    "unreadNotificationCount",
    () => 0,
  );
  const previousUnreadCount = useState<number>(
    "previousUnreadNotificationCount",
    () => 0,
  );
  let audioContext: AudioContext | null = null;
  let hasInitializedUnreadCount = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let listenersAttached = false;

  const hasActiveSession = () => !!authStore.user;

  const detach = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
    if (listenersAttached) {
      window.removeEventListener("focus", refreshUnreadNotificationCount);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener(
        "nusift:notifications:update",
        refreshUnreadNotificationCount,
      );
      listenersAttached = false;
    }
  };

  const playNotificationTone = async () => {
    try {
      if (!("AudioContext" in window || "webkitAudioContext" in window)) return;
      audioContext ||= new (
        window.AudioContext || (window as any).webkitAudioContext
      )();

      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => null);
      }

      const now = audioContext.currentTime;
      const gain = audioContext.createGain();
      const oscillator = audioContext.createOscillator();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.08);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.5, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.24);
    } catch (error) {
      console.warn("[notifications] failed to play tone", error);
    }
  };

  const refreshUnreadNotificationCount = async () => {
    if (!hasActiveSession()) {
      unreadNotificationCount.value = 0;
      previousUnreadCount.value = 0;
      detach();
      return;
    }
    try {
      const res = await $fetch<{ unreadCount: number }>("/api/notifications");
      const nextCount = res.unreadCount || 0;
      const prevCount = previousUnreadCount.value;
      unreadNotificationCount.value = nextCount;
      previousUnreadCount.value = nextCount;

      if (
        hasInitializedUnreadCount &&
        nextCount > prevCount &&
        document.visibilityState === "visible"
      ) {
        void playNotificationTone();
      }

      hasInitializedUnreadCount = true;
    } catch (error) {
      console.warn("[notifications] failed to refresh unread count", error);
    }
  };

  const refreshIfVisible = () => {
    if (document.visibilityState === "visible") {
      void refreshUnreadNotificationCount();
    }
  };

  if (import.meta.client) {
    const attach = () => {
      if (!hasActiveSession()) return;
      if (listenersAttached) return;
      void refreshUnreadNotificationCount();
      intervalId = setInterval(refreshUnreadNotificationCount, 30000);
      window.addEventListener("focus", refreshUnreadNotificationCount);
      document.addEventListener("visibilitychange", refreshIfVisible);
      window.addEventListener(
        "nusift:notifications:update",
        refreshUnreadNotificationCount,
      );
      listenersAttached = true;
    };

    nuxtApp.hook("app:mounted", attach);
    watch(
      () => authStore.user,
      () => {
        if (!hasActiveSession()) {
          detach();
          unreadNotificationCount.value = 0;
          previousUnreadCount.value = 0;
        } else if (!listenersAttached) {
          attach();
        }
      },
      { immediate: true },
    );
  }

  return {
    provide: {
      refreshUnreadNotifications: refreshUnreadNotificationCount,
    },
  };
});
