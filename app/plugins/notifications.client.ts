export default defineNuxtPlugin((nuxtApp) => {
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

  let intervalId: ReturnType<typeof setInterval> | undefined;

  if (import.meta.client) {
    const attach = () => {
      void refreshUnreadNotificationCount();
      intervalId = setInterval(refreshUnreadNotificationCount, 30000);
      window.addEventListener("focus", refreshUnreadNotificationCount);
      document.addEventListener("visibilitychange", refreshIfVisible);
      window.addEventListener(
        "nusift:notifications:update",
        refreshUnreadNotificationCount,
      );
    };

    nuxtApp.hook("app:mounted", attach);
  }

  return {
    provide: {
      refreshUnreadNotifications: refreshUnreadNotificationCount,
    },
  };
});
