/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
export {};

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data?.json?.() ?? {};
    } catch {
      try {
        const text = event.data?.text?.();
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    }
  })();
  const receivedAt = Date.now();
  const sentAt = typeof data.sentAt === "string" ? Date.parse(data.sentAt) : NaN;
  if (!Number.isNaN(sentAt)) {
    console.info("[sw] push received", {
      type: data.type || "DAILY_DIGEST",
      deliveryDelayMs: receivedAt - sentAt,
    });
  } else {
    console.info("[sw] push received", {
      type: data.type || "DAILY_DIGEST",
    });
  }
  const title = data.title || "NuSift";
  const options: NotificationOptions = {
    body: data.body || "You have a new update.",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: data.type || "NUSIFT_NOTIFICATION",
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [200, 100, 200],
    data: { url: data.url || "/dashboard", type: data.type || "DAILY_DIGEST" },
  };
  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .catch((error) => console.error("[sw] showNotification failed", error)),
  );
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
