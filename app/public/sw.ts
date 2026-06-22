/// <reference lib="webworker" />
export {};

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const data = event.data?.json?.() ?? {};
  const title = data.title || "NuSift";
  const options: NotificationOptions = {
    body: data.body || "You have a new update.",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    data: { url: data.url || "/dashboard", type: data.type || "DAILY_DIGEST" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data as any)?.url || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && "navigate" in client) {
          const windowClient = client as WindowClient;
          if (windowClient.url.includes(targetUrl)) return windowClient.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
