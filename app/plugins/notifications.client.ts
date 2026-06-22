export default defineNuxtPlugin((nuxtApp) => {
  const unreadNotificationCount = useState<number>("unreadNotificationCount", () => 0);

  const refreshUnreadNotificationCount = async () => {
    try {
      const res = await $fetch<{ unreadCount: number }>("/api/notifications");
      unreadNotificationCount.value = res.unreadCount || 0;
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
      window.addEventListener("nusift:notifications:update", refreshUnreadNotificationCount);
    };

    nuxtApp.hook("app:mounted", attach);
  }

  return {
    provide: {
      refreshUnreadNotifications: refreshUnreadNotificationCount,
    },
  };
});
