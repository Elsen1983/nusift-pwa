<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-6 pb-24 overflow-hidden">
    <section class="px-2 space-y-2">
      <div class="flex items-center gap-3">
        <span class="material-symbols-outlined text-primary-container text-2xl">notifications</span>
        <h1 class="font-headline text-2xl font-bold text-on-surface tracking-tight">
          {{ $t("notificationsPage.title") }}
        </h1>
      </div>
      <p class="text-on-surface-variant text-sm font-body pl-[40px]">
        {{ $t("notificationsPage.description") }}
      </p>
    </section>

    <section class="space-y-3">
      <div class="rounded-3xl border border-outline-variant/10 bg-surface-container-low shadow-lg overflow-hidden">
        <button class="w-full flex items-center justify-between p-4 text-left" @click="open.new = !open.new">
          <div>
            <div class="font-body text-[15px] font-medium text-on-surface">{{ $t("notificationsPage.sections.new") }}</div>
            <div class="text-xs text-on-surface-variant">{{ newNotifications.length }} {{ $t("notificationsPage.items") }}</div>
          </div>
          <span class="material-symbols-outlined transition-transform" :class="open.new ? 'rotate-180' : ''">expand_more</span>
        </button>
        <div v-show="open.new" class="px-4 pb-4 space-y-3">
          <div
            v-for="item in newNotifications"
            :key="item.id"
            class="rounded-2xl border border-primary-container/25 bg-primary-container/5 p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="text-left min-w-0 flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] uppercase tracking-widest px-2 py-1 rounded-full border border-primary-container/30 text-primary-container">New</span>
                </div>
                <div class="font-body text-[15px] font-medium text-on-surface break-words">{{ item.title }}</div>
                <div class="text-sm text-on-surface-variant mt-1 break-words">{{ item.body }}</div>
                <div v-if="item.type === 'FRIEND_REQUEST'" class="flex gap-2 mt-3" @click.stop>
                  <button class="px-3 py-2 rounded-full bg-primary-container text-on-primary-container text-sm font-medium border border-primary-container/40 min-w-[4.5rem]" @click="acceptFriendRequest(item)">Accept</button>
                  <button class="px-3 py-2 rounded-full border border-outline-variant text-on-surface text-sm font-medium bg-surface-container min-w-[4.5rem]" @click="declineFriendRequest(item)">Decline</button>
                </div>
                <button v-else class="mt-3 text-sm text-primary" @click="markRead(item.id)">Mark as read</button>
              </div>
              <button
                v-if="item.type !== 'FRIEND_REQUEST'"
                class="p-2 rounded-full hover:bg-error/10 text-on-surface-variant hover:text-error"
                @click="deleteNotification(item.id)"
              >
                <span class="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          </div>
          <div v-if="!newNotifications.length" class="rounded-2xl border border-dashed border-outline-variant/20 p-6 text-sm text-on-surface-variant">
            {{ $t("notificationsPage.empty.new") }}
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-outline-variant/10 bg-surface-container-low shadow-lg overflow-hidden">
        <button class="w-full flex items-center justify-between p-4 text-left" @click="open.read = !open.read">
          <div>
            <div class="font-body text-[15px] font-medium text-on-surface">{{ $t("notificationsPage.sections.read") }}</div>
            <div class="text-xs text-on-surface-variant">{{ readNotifications.length }} {{ $t("notificationsPage.items") }}</div>
          </div>
          <span class="material-symbols-outlined transition-transform" :class="open.read ? 'rotate-180' : ''">expand_more</span>
        </button>
        <div v-show="open.read" class="px-4 pb-4 space-y-3">
          <div
            v-for="item in readNotifications"
            :key="item.id"
            class="rounded-2xl border border-outline-variant/15 bg-surface-container p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] uppercase tracking-widest px-2 py-1 rounded-full border border-outline-variant/20 text-on-surface-variant">Read</span>
                </div>
                <div class="font-body text-[15px] font-medium text-on-surface break-words">{{ item.title }}</div>
                <div class="text-sm text-on-surface-variant mt-1 break-words">{{ item.body }}</div>
              </div>
              <button class="p-2 rounded-full hover:bg-error/10 text-on-surface-variant hover:text-error" @click="deleteNotification(item.id)">
                <span class="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          </div>
          <div v-if="!readNotifications.length" class="rounded-2xl border border-dashed border-outline-variant/20 p-6 text-sm text-on-surface-variant">
            {{ $t("notificationsPage.empty.read") }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: "app-layout" });

type NotificationItem = {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: string;
  title: string;
  body: string;
  url?: string | null;
  payload?: any;
  status: string;
  sentAt?: string | null;
  readAt?: string | null;
};

const open = reactive({ new: true, read: false });
const unreadNotificationCount = useState<number>("unreadNotificationCount", () => 0);
const { data, refresh } = await useAsyncData(
  "notifications",
  () => $fetch<{ unreadCount: number; notifications: NotificationItem[] }>("/api/notifications"),
  { server: false },
);

const notifications = computed(() => data.value?.notifications || []);
const newNotifications = computed(() => notifications.value.filter((item) => !item.readAt));
const readNotifications = computed(() => notifications.value.filter((item) => !!item.readAt));

const syncUnreadCount = async () => {
  const res = await $fetch<{ unreadCount: number }>("/api/notifications");
  unreadNotificationCount.value = res.unreadCount || 0;
};

async function acceptFriendRequest(item: NotificationItem) {
  const connectionId = item.payload?.connectionId;
  if (!connectionId) return;
  try {
    await $fetch(`/api/friends/requests/${connectionId}/accept`, {
      method: "POST",
      body: { notificationId: item.id },
    });
  } catch (error: any) {
    if (error?.data?.statusCode === 409) {
      await deleteNotification(item.id);
      return;
    }
    throw error;
  }
  await refresh();
  await syncUnreadCount();
}

async function declineFriendRequest(item: NotificationItem) {
  const connectionId = item.payload?.connectionId;
  if (!connectionId) return;
  try {
    await $fetch(`/api/friends/requests/${connectionId}/decline`, {
      method: "POST",
      body: { notificationId: item.id },
    });
  } catch (error: any) {
    if (error?.data?.statusCode === 409) {
      await deleteNotification(item.id);
      return;
    }
    throw error;
  }
  await refresh();
  await syncUnreadCount();
}

async function markRead(id: string) {
  await $fetch(`/api/notifications/${id}`, { method: "PATCH" });
  await refresh();
  await syncUnreadCount();
  if (import.meta.client) window.dispatchEvent(new Event("nusift:notifications:update"));
}

async function deleteNotification(id: string) {
  await $fetch(`/api/notifications/${id}`, { method: "DELETE" });
  await refresh();
  await syncUnreadCount();
  if (import.meta.client) window.dispatchEvent(new Event("nusift:notifications:update"));
}

onMounted(() => {
  void syncUnreadCount();
});
</script>
