<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-4 pb-20 overflow-hidden">
    <section class="flex items-center gap-4 px-2">
      <div
        class="w-16 h-16 rounded-full border border-primary-container/30 p-0.5 shrink-0 shadow-[0_0_15px_rgba(0,229,255,0.1)] relative overflow-hidden bg-surface-container"
      >
        <div 
           v-if="!isClientHydrated && !topAvatarUrl" 
           class="absolute inset-0 animate-pulse bg-outline-variant/20 rounded-full"
        ></div>

        <img
          v-if="topAvatarUrl"
          :src="topAvatarUrl"
          class="w-full h-full object-cover rounded-full transition-opacity duration-300 opacity-100"
          alt="Avatar"
          @error="console.error('Avatar load error')" 
        />
      </div>
      <div class="min-w-0">
        <h2 class="font-headline text-2xl font-bold text-primary truncate">
          {{ authStore.user?.profile?.nickname || "Sovereign User" }}
        </h2>
        <p class="text-on-surface-variant text-sm font-label">
          {{ authStore.user?.email }}
        </p>
      </div>
    </section>
    <!-- ACCOUNT SETTINGS -->
    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("myProfile.sections.account") }}
      </h4>
      
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col p-5">
        
        <button
          @click="toggleMenu('account')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none rounded-t-[20px]"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">manage_accounts</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.menu.settings") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'account' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'account'" class="py-3 px-3 border-t border-outline-variant/10 rounded-2xl bg-surface-container-lowest/50">
          <AccountSettingsForm />
        </div>

        <div class="h-px w-full bg-outline-variant/10"></div>

        <button
          @click="toggleMenu('subscription')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">loyalty</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.menu.subscription") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'subscription' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'subscription'" class="py-3 px-2 border-t border-outline-variant/10 bg-surface-container-lowest/50 text-sm text-on-surface-variant">
          <p>Active Plan: <strong class="text-primary">{{ authStore.user?.tier || 'FREE' }}</strong></p>
        </div>

        <div class="h-px w-full bg-outline-variant/10"></div>

        <button
          @click="toggleMenu('billing')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none rounded-b-[20px]"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">credit_card</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.menu.billing") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'billing' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'billing'" class="py-3 px-2 border-t border-outline-variant/10 bg-surface-container-lowest/50 text-sm text-on-surface-variant">
          <p>No recent invoices found.</p>
        </div>

      </div>
    </section>

    <!-- FRIENDS -->
    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("myProfile.sections.friends") }}
      </h4>

      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col p-5 space-y-3">
        <button
          @click="toggleMenu('friends-current')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none rounded-[18px]"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">group</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.friends.currentFriends") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'friends-current' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'friends-current'" class="pt-2 px-2 pb-2 rounded-2xl bg-surface-container-lowest/50 border border-outline-variant/10 space-y-2">
          <div v-if="friends.length" class="space-y-2">
            <div v-for="friend in friends" :key="friend.id" class="flex items-center gap-3 rounded-2xl border border-outline-variant/10 bg-surface-container p-3">
              <div class="w-10 h-10 rounded-full bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">
                <img v-if="friend.avatarUrl" :src="friend.avatarUrl" class="w-full h-full object-cover" alt="" />
                <span v-else class="material-symbols-outlined text-on-surface-variant">person</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-body text-[14px] font-medium text-on-surface truncate">{{ friend.nickname || friend.email }}</div>
                <div class="text-xs text-on-surface-variant truncate">{{ friend.email }}</div>
              </div>
              <button
                class="px-3 py-2 rounded-full border border-outline-variant text-on-surface text-sm font-medium bg-surface-container hover:bg-error/10 hover:text-error"
                @click="removeFriend(friend)"
              >
                Remove
              </button>
            </div>
          </div>
          <div v-else class="rounded-2xl border border-dashed border-outline-variant/20 p-4 text-sm text-on-surface-variant">
            {{ $t("myProfile.friends.emptyFriends") }}
          </div>
        </div>

        <button
          @click="toggleMenu('friends-search')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none rounded-[18px]"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">person_add</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.friends.searchNewFriends") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'friends-search' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'friends-search'" class="pt-2 px-2 pb-2 rounded-2xl bg-surface-container-lowest/50 border border-outline-variant/10 space-y-3">
          <div class="flex gap-2">
            <input
              v-model="friendSearchQuery"
              type="text"
              class="flex-1 min-w-0 rounded-2xl border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none focus:border-primary-container"
              :placeholder="$t('myProfile.friends.searchPlaceholder')"
            />
            <button
              class="px-4 py-3 rounded-2xl bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50 border border-primary-container/40"
              :disabled="isSearchingFriends || friendSearchQuery.trim().length < 2"
              @click="searchFriends"
            >
              {{ $t("myProfile.friends.searchButton") }}
            </button>
          </div>

          <div v-if="friendSearchResults.length" class="space-y-2">
            <div v-for="user in friendSearchResults" :key="user.id" class="flex items-center gap-3 rounded-2xl border border-outline-variant/10 bg-surface-container-low p-3">
              <div class="w-10 h-10 rounded-full bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">
                <img v-if="user.avatarUrl" :src="user.avatarUrl" class="w-full h-full object-cover" alt="" />
                <span v-else class="material-symbols-outlined text-on-surface-variant">person_add</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-body text-[14px] font-medium text-on-surface truncate">{{ user.nickname || user.email }}</div>
                <div class="text-xs text-on-surface-variant truncate">{{ user.email }}</div>
              </div>
              <!-- Connection status badges / invite button -->
              <span
                v-if="user.connectionStatus === 'ACCEPTED'"
                class="px-3 py-2 rounded-full text-xs font-medium border border-primary-container/40 text-primary-container bg-primary-container/10"
              >
                {{ $t("myProfile.friends.statusFriend") }}
              </span>
              <span
                v-else-if="user.connectionStatus === 'PENDING'"
                class="px-3 py-2 rounded-full text-xs font-medium border border-tertiary-fixed/40 text-tertiary-fixed bg-tertiary-fixed/10"
              >
                {{ $t("myProfile.friends.statusPending") }}
              </span>
              <span
                v-else-if="user.connectionStatus === 'BLOCKED'"
                class="px-3 py-2 rounded-full text-xs font-medium border border-error/40 text-error bg-error/10"
              >
                {{ $t("myProfile.friends.statusBlocked") }}
              </span>
              <button
                v-else
                class="px-3 py-2 rounded-full border border-primary-container text-primary text-sm disabled:opacity-50 bg-surface-container"
                :disabled="sendingInviteId === user.id"
                @click="sendFriendInvite(user)"
              >
                {{ $t("myProfile.friends.sendInvite") }}
              </button>
            </div>
          </div>
          <div v-else-if="friendSearchDone" class="rounded-2xl border border-dashed border-outline-variant/20 p-4 text-sm text-on-surface-variant">
            {{ $t("myProfile.friends.noSearchResults") }}
          </div>
        </div>

        <button
          @click="toggleMenu('friends-pending')"
          class="w-full flex items-center justify-between px-1 py-3 hover:bg-surface-container-highest transition-colors group outline-none rounded-[18px]"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">schedule</span>
            <span class="font-body text-[15px] font-medium">{{ $t("myProfile.friends.pendingFriends") }}</span>
          </div>
          <span
            class="material-symbols-outlined text-outline-variant transition-transform duration-300"
            :class="openMenu === 'friends-pending' ? 'rotate-90 text-primary' : 'group-hover:text-primary'"
          >chevron_right</span>
        </button>

        <div v-show="openMenu === 'friends-pending'" class="pt-2 px-2 pb-2 rounded-2xl bg-surface-container-lowest/50 border border-outline-variant/10 space-y-2">
          <div v-if="pendingFriends.length" class="space-y-2">
            <div v-for="friend in pendingFriends" :key="friend.connectionId" class="flex items-center gap-3 rounded-2xl border border-outline-variant/10 bg-surface-container p-3">
              <div class="w-10 h-10 rounded-full bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">
                <img v-if="friend.avatarUrl" :src="friend.avatarUrl" class="w-full h-full object-cover" alt="" />
                <span v-else class="material-symbols-outlined text-on-surface-variant">person</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-body text-[14px] font-medium text-on-surface truncate">
                  {{ friend.nickname || friend.email }}
                </div>
                <div class="text-xs text-on-surface-variant truncate mt-0.5">
                  {{ friend.email }}
                </div>
                <div class="mt-2">
                  <span
                    class="text-[10px] uppercase tracking-widest px-2 py-1 rounded-full border inline-flex"
                    :class="friend.direction === 'SENT'
                      ? 'border-primary-container/40 text-primary-container bg-primary-container/10'
                      : 'border-tertiary-fixed/40 text-tertiary-fixed bg-tertiary-fixed/10'"
                  >
                    {{ friend.direction === 'SENT' ? $t("myProfile.friends.sentByYou") : $t("myProfile.friends.received") }}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="rounded-2xl border border-dashed border-outline-variant/20 p-4 text-sm text-on-surface-variant">
            {{ $t("myProfile.friends.emptyPending") }}
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-error/20 bg-surface-container-low p-5 shadow-lg">
        <div class="flex items-start gap-4">
          <div class="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-error/20 bg-error/10">
            <span class="material-symbols-outlined text-error">delete_forever</span>
          </div>
          <div class="min-w-0 flex-1">
            <h5 class="font-headline text-base font-bold uppercase tracking-wide text-on-surface">
              {{ $t("myProfile.deleteAccount.title") }}
            </h5>
            <p class="mt-1 text-sm leading-relaxed text-on-surface-variant">
              {{ $t("myProfile.deleteAccount.summary") }}
            </p>

            <button
              class="mt-4 inline-flex min-h-11 items-center justify-center rounded-2xl border border-error/30 bg-error/10 px-5 py-3 text-sm font-bold uppercase tracking-widest text-error transition-colors hover:bg-error hover:text-on-error disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isDeletingAccount"
              @click="openDeleteAccountModal"
            >
              {{ isDeletingAccount ? $t("myProfile.deleteAccount.deleting") : $t("myProfile.deleteAccount.button") }}
            </button>

            <p class="mt-3 text-xs leading-relaxed text-on-surface-variant">
              {{ $t("myProfile.deleteAccount.caption") }}
            </p>
            <p v-if="deleteAccountError" class="mt-2 text-xs leading-relaxed text-error">
              {{ deleteAccountError }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- SOURCE STATUS -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("myProfile.sections.sources") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl p-5 border border-outline-variant/10 shadow-lg relative overflow-hidden"
      >
        <div
          class="absolute -left-10 -top-10 w-40 h-40 bg-primary-container/5 blur-3xl rounded-full pointer-events-none"
        ></div>
        <div
          class="relative z-10 flex items-center gap-5 w-full justify-center"
        >
          <div
            class="relative w-[7.5rem] h-[7.5rem] shrink-0 flex items-center justify-center"
          >
            <svg
              viewBox="0 0 120 120"
              class="w-full h-full transform -rotate-90"
            >
              <circle
                v-for="ring in sourceRings"
                :key="`${ring.labelKey}-track`"
                cx="60"
                cy="60"
                :r="ring.radius"
                stroke="currentColor"
                :stroke-width="ring.strokeWidth"
                fill="transparent"
                class="text-surface-container-highest"
              />
              <circle
                v-for="ring in sourceRings"
                :key="ring.labelKey"
                cx="60"
                cy="60"
                :r="ring.radius"
                stroke="currentColor"
                :stroke-width="ring.strokeWidth"
                fill="transparent"
                :stroke-dasharray="ring.circumference"
                :stroke-dashoffset="
                  ring.circumference -
                  (ring.percentage / 100) * ring.circumference
                "
                :class="[
                  ring.ringClass,
                  'transition-all duration-1000 ease-out',
                ]"
                stroke-linecap="round"
              />
            </svg>
          </div>

          <div class="min-w-0 flex-1 max-w-[200px] space-y-3">
            <div
              v-for="ring in sourceRings"
              :key="`${ring.labelKey}-legend`"
              class="flex items-center justify-between gap-3"
            >
              <div class="flex items-center gap-2 min-w-0">
                <span
                  :class="[
                    ring.ringClass,
                    'w-2.5 h-2.5 rounded-full bg-current shadow-[0_0_8px_currentColor] shrink-0',
                  ]"
                ></span>
                <span
                  class="font-label text-[11px] uppercase tracking-wider text-on-surface-variant truncate"
                >
                  {{ $t(ring.labelKey) }}
                </span>
              </div>

              <div class="shrink-0">
                <span
                  :class="[
                    ring.countClass,
                    'font-headline font-bold text-base leading-none',
                  ]"
                >
                  {{ ring.count }}
                </span>
                <span
                  v-if="ring.usesLimit"
                  class="text-on-surface-variant font-headline font-bold text-base leading-none"
                  >/{{ limit }}</span
                >
              </div>
            </div>
          </div>
        </div>

        <button
          v-if="!isPro"
          class="relative z-10 mt-4 w-full px-4 py-2 bg-primary-container/10 text-primary-container border border-primary-container/30 rounded-xl text-[11px] font-bold uppercase tracking-wider hover:bg-primary-container/20 transition-colors"
        >
          {{ $t("myProfile.quota.upgrade") }}
        </button>
      </div>
    </section>

    <!-- SCANNED ARTICLES TIMELINE -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("myProfile.sections.timeline") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl p-5 border border-outline-variant/10 shadow-lg relative overflow-hidden"
      >
        <div
          class="absolute -left-10 -top-10 w-40 h-40 bg-primary-container/5 blur-3xl rounded-full pointer-events-none"
        ></div>
        <div class="relative z-10">
          <SourceTimelineChart
            :timeline-data="rawTimelineData"
            :is-loading="isAnalyticsLoading"
          />
        </div>
      </div>
    </section>

    <!-- ARTICLES VISUALIZATION -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("myProfile.sections.impact") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl px-4 border border-outline-variant/10 shadow-lg relative overflow-hidden"
      >
        <ArticleInteractionGraph :metrics="articlesStateMetrics" />
      </div>
    </section>

    <!-- COMPACT IMPACT DASHBOARD -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("myProfile.sections.impact") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl p-4 border border-outline-variant/10 shadow-lg relative overflow-hidden"
      >
        <!-- Minimal Top Glow -->
        <div
          class="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-4 bg-primary-container/20 blur-xl rounded-full pointer-events-none"
        ></div>

        <div
          class="grid grid-cols-3 divide-x divide-outline-variant/10 relative z-10"
        >
          <!-- Metric 1: Time -->
          <div
            class="flex flex-col items-center justify-center text-center px-1"
          >
            <span
              class="material-symbols-outlined text-primary-container text-base mb-1.5 opacity-80"
              >timelapse</span
            >
            <div
              class="text-on-surface font-headline font-bold text-xl leading-none mb-1"
            >
              {{ impactMetrics.timeSaved
              }}<span class="text-sm ml-0.5 text-on-surface-variant">h</span>
            </div>
            <p
              class="text-on-surface-variant text-[9px] font-label uppercase tracking-widest leading-tight"
            >
              {{ $t("myProfile.impact.time_short") }}
            </p>
          </div>

          <!-- Metric 2: Data -->
          <div
            class="flex flex-col items-center justify-center text-center px-1"
          >
            <span
              class="material-symbols-outlined text-primary-container text-base mb-1.5 opacity-80"
              >data_usage</span
            >
            <div
              class="text-on-surface font-headline font-bold text-xl leading-none mb-1"
            >
              {{ impactMetrics.dataSaved
              }}<span class="text-sm ml-0.5 text-on-surface-variant">GB</span>
            </div>
            <p
              class="text-on-surface-variant text-[9px] font-label uppercase tracking-widest leading-tight"
            >
              {{ $t("myProfile.impact.data_short") }}
            </p>
          </div>

          <!-- Metric 3: AI -->
          <div
            class="flex flex-col items-center justify-center text-center px-1"
          >
            <span
              class="material-symbols-outlined text-primary-container text-base mb-1.5 opacity-80"
              >memory</span
            >
            <div
              class="text-on-surface font-headline font-bold text-xl leading-none mb-1"
            >
              {{ impactMetrics.articlesScanned }}
            </div>
            <p
              class="text-on-surface-variant text-[9px] font-label uppercase tracking-widest leading-tight"
            >
              {{ $t("myProfile.impact.ai_work_short") }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <div class="flex items-center justify-end px-4 pt-4">
      <span class="text-on-surface-variant text-xs font-label">
        {{ $t("preloaderFirst.version") || "Version 1.0.0" }}
      </span>
    </div>
  </div>

  <DeleteAccountModal
    :is-open="isDeleteAccountModalOpen"
    :is-deleting="isDeletingAccount"
    @close="isDeleteAccountModalOpen = false"
    @confirm="deleteAccount"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { $api } from "~/utils/api";
import { buildAvatarUrlMap, resolveAvatarUrlFromMap } from "~/utils/avatar";
import defaultAvatar from "~/assets/images/default_avatar.png";
import SourceTimelineChart from "~/components/SourceTimelineChart.vue";

definePageMeta({
  layout: "app-layout",
});

const authStore = useAuthStore();
const isClientHydrated = ref(false);

// --- AVATAR RESOLVER LOGIC ---
const _avatarModules = import.meta.glob('/assets/images/avatars/*.{png,jpg,jpeg,webp,svg}', { eager: true, query: '?url', import: 'default' });
const avatarByBasename = buildAvatarUrlMap(_avatarModules as Record<string, unknown>);

/// Computed avatar logic
const profileAvatarUrl = ref("");

const topAvatarUrl = computed(() => {
  // 1. Nyers adat kiszedése a store-ból (ez valószínűleg csak a fájlnév, pl. "avatar_1.png")
  const rawAvatar =
    profileAvatarUrl.value ||
    authStore.user?.profile?.avatarUrl ||
    (authStore.user?.profile as any)?.avatar;
  
  // 2. A fájlnév átfordítása a valós Nuxt/Vite asset URL-re
  const realAvatar = resolveAvatarUrlFromMap(rawAvatar, avatarByBasename) || "";

  // 3. Ha sikeres a feloldás, mutatjuk az egyedi avatart
  if (realAvatar) return realAvatar;
  if (profileAvatarUrl.value) return profileAvatarUrl.value;

  // 4. Ha még töltünk (hidratálunk), nem mutatunk semmit (üres állapot/skeleton)
  if (!isClientHydrated.value) return ""; 

  // 5. Ha minden betöltött és tényleg nincs avatarja a usernek, jöhet az alapértelmezett
  return defaultAvatar;
});

const isPro = computed(() => authStore.user?.tier === "PRO");
// --- MOCK DATA ---
// Ezeket később egy API végpontról (`/api/user/analytics`) fogjuk behúzni
const activeCount = ref(0);
const suspendedCount = ref(0);
const restrictedCount = ref(0);
const limit = ref(5);

const rawTimelineData = ref([]);
const isAnalyticsLoading = ref(true);

const impactMetrics = ref({
  timeSaved: 14, // Óra ebben a hónapban
  dataSaved: 4.2, // GB megspórolt adatforgalom
  articlesScanned: 342, // Deep Scan által feltérképezett cikkek
});

const articlesStateMetrics = ref({
  readArticles: 0,
  savedArticles: 0,
  sharedArticles: 0,
  rejectedArticles: 0,
});

const openMenu = ref<string | null>(null);
const toggleMenu = (menuName: string) => {
  openMenu.value = openMenu.value === menuName ? null : menuName;
};

type FriendItem = {
  connectionId: string;
  id: string;
  email: string;
  nickname: string | null;
  avatarUrl: string | null;
  connectionStatus?: string | null;
};

type PendingFriendItem = FriendItem & {
  direction: "SENT" | "RECEIVED";
};

const resolveFriendAvatar = (avatarUrl?: string | null) => {
  if (!avatarUrl) return null;
  return resolveAvatarUrlFromMap(avatarUrl, avatarByBasename) || avatarUrl;
};

const friends = ref<FriendItem[]>([]);
const pendingFriends = ref<PendingFriendItem[]>([]);
const friendSearchQuery = ref("");
const friendSearchResults = ref<FriendItem[]>([]);
const friendSearchDone = ref(false);
const isSearchingFriends = ref(false);
const sendingInviteId = ref("");
const isDeleteAccountModalOpen = ref(false);
const isDeletingAccount = ref(false);
const deleteAccountError = ref("");

const loadFriends = async () => {
  try {
    const res: any = await $api("/api/friends");
    friends.value = (res?.friends || []).map((friend: FriendItem) => ({
      ...friend,
      connectionId: friend.connectionId,
      avatarUrl: resolveFriendAvatar(friend.avatarUrl),
    }));
    pendingFriends.value = (res?.pending || []).map((friend: PendingFriendItem) => ({
      ...friend,
      connectionId: friend.connectionId,
      avatarUrl: resolveFriendAvatar(friend.avatarUrl),
    }));
  } catch (error) {
    console.error("Failed to load friends:", error);
  }
};

const searchFriends = async () => {
  const q = friendSearchQuery.value.trim();
  if (q.length < 2) return;

  isSearchingFriends.value = true;
  friendSearchDone.value = false;

  try {
    const res: any = await $api(`/api/users/search?q=${encodeURIComponent(q)}`);
    friendSearchResults.value = (res?.users || []).map((user: FriendItem) => ({
      ...user,
      connectionId: "",
      connectionStatus: user.connectionStatus || null,
      avatarUrl: resolveFriendAvatar(user.avatarUrl),
    }));
    friendSearchDone.value = true;
  } catch (error) {
    console.error("Failed to search friends:", error);
    friendSearchResults.value = [];
    friendSearchDone.value = true;
  } finally {
    isSearchingFriends.value = false;
  }
};

const sendFriendInvite = async (user: FriendItem) => {
  sendingInviteId.value = user.id;
  try {
    await $api("/api/friends/request", {
      method: "POST",
      body: { target: user.nickname || user.email },
    });
    friendSearchQuery.value = "";
    friendSearchResults.value = [];
    friendSearchDone.value = false;
    await loadFriends();
  } catch (error) {
    console.error("Failed to send friend invite:", error);
  } finally {
    sendingInviteId.value = "";
  }
};

const removeFriend = async (friend: FriendItem) => {
  try {
    await $api(`/api/friends/requests/${friend.connectionId}/remove`, {
      method: "POST",
    });
    await loadFriends();
  } catch (error) {
    console.error("Failed to remove friend:", error);
  }
};

const openDeleteAccountModal = () => {
  deleteAccountError.value = "";
  isDeleteAccountModalOpen.value = true;
};

const deleteAccount = async () => {
  if (isDeletingAccount.value) return;

  isDeletingAccount.value = true;
  deleteAccountError.value = "";

  try {
    await $api("/api/user/account", {
      method: "DELETE",
    });

    authStore.$reset();
    if (import.meta.client) {
      window.location.href = "/auth";
    }
  } catch (error: any) {
    console.error("Failed to delete account:", error);
    deleteAccountError.value =
      error?.response?._data?.normalizedMessage ||
      error?.data?.statusMessage ||
      error?.message ||
      "Failed to delete account.";
  } finally {
    isDeletingAccount.value = false;
    if (!deleteAccountError.value) {
      isDeleteAccountModalOpen.value = false;
    }
  }
};

const syncAvatarFromProfile = (profile: any) => {
  const storedAvatar = profile?.avatarUrl || profile?.avatar;
  const resolvedAvatar = resolveAvatarUrlFromMap(storedAvatar, avatarByBasename);
  profileAvatarUrl.value = resolvedAvatar || "";
};

watch(
  () => authStore.user?.profile,
  (profile) => {
    syncAvatarFromProfile(profile);
  },
  { immediate: true, deep: true },
);

onMounted(async () => {
  // Refresh the authenticated profile first so the avatar reflects the latest
  // saved value even after a hard refresh.
  try {
    const profileResponse: any = await $api("/api/user/profile");
    if (profileResponse && profileResponse.success && profileResponse.profile) {
      authStore.updateUserProfileLocally(profileResponse.profile);
      syncAvatarFromProfile(profileResponse.profile);
    }
  } catch (error) {
    console.error("Nem sikerült frissíteni a profil adatokat:", error);
  }

  try {
const [sourcesResponse, analyticsMetricsResponse, analyticsTimelineResponse] = await Promise.all([
      $api<any>("/api/user/sources"),
      $api<any>("/api/user/analytics-metrics"),
      $api<any>("/api/user/analytics-timeline"),
    ]);

    if (sourcesResponse && sourcesResponse.success) {
      limit.value = sourcesResponse.quota.limit;
      const sources = sourcesResponse.sources;

      activeCount.value = sources.filter(
        (s: any) =>
          s.isActive &&
          s.validationStatus !== "FAILED" &&
          s.validationStatus !== "DOMAIN_DEAD",
      ).length;
      suspendedCount.value = sources.filter(
        (s: any) =>
          !s.isActive &&
          s.validationStatus !== "FAILED" &&
          s.validationStatus !== "DOMAIN_DEAD",
      ).length;
      restrictedCount.value = sources.filter(
        (s: any) =>
          s.validationStatus === "FAILED" ||
          s.validationStatus === "DOMAIN_DEAD",
      ).length;
    }

    if (analyticsTimelineResponse && analyticsTimelineResponse.success) {
      console.log("Analytics timeline API response:", analyticsTimelineResponse);

      if (analyticsTimelineResponse.data) {
        console.log(
          "Received timeline data from analytics timeline API:",
          analyticsTimelineResponse.data,
        );
        rawTimelineData.value = analyticsTimelineResponse.data;
      } else {
        console.warn("Analytics timeline API response does not contain 'data'.");
      }
    }

    if (analyticsMetricsResponse && analyticsMetricsResponse.success) {
      if (analyticsMetricsResponse.metrics) {
        console.log(
          "Received metrics from analytics metrics API:",
          analyticsMetricsResponse.metrics,
        );
        articlesStateMetrics.value = {
          readArticles: analyticsMetricsResponse.metrics.read,
          savedArticles: analyticsMetricsResponse.metrics.saved,
          sharedArticles: analyticsMetricsResponse.metrics.shared,
          rejectedArticles: analyticsMetricsResponse.metrics.rejected,
        };
      }
    }
  } catch (error) {
    console.error("Nem sikerült lekérni a profil kvóta adatait:", error);

    // Biztonsági fallback: ha hálózati hiba van, a Store-ból olvassuk ki a legutóbbi ismert állapotot
    if (authStore.user?.topSources) {
      const storedSources = authStore.user.topSources.filter(
        (s: any) => typeof s !== "string",
      );

      limit.value = authStore.user.tier === "PRO" ? 15 : 5;
      activeCount.value = storedSources.filter(
        (s: any) =>
          s.isActive &&
          s.validationStatus !== "FAILED" &&
          s.validationStatus !== "DOMAIN_DEAD",
      ).length;
      suspendedCount.value = storedSources.filter(
        (s: any) =>
          !s.isActive &&
          s.validationStatus !== "FAILED" &&
          s.validationStatus !== "DOMAIN_DEAD",
      ).length;
      restrictedCount.value = storedSources.filter(
        (s: any) =>
          s.validationStatus === "FAILED" ||
          s.validationStatus === "DOMAIN_DEAD",
      ).length;
    }
  } finally {
    isAnalyticsLoading.value = false; // Betöltési állapot frissítése, hogy a hibás állapotban is megjelenjen a UI
    isClientHydrated.value = true;
  }

  await loadFriends();
});

const getSourcePercentage = (count: number) => {
  if (limit.value <= 0) return 0;
  return Math.min(100, Math.round((count / limit.value) * 100));
};

const totalSourceCount = computed(
  () => activeCount.value + suspendedCount.value + restrictedCount.value,
);

const getSourceSharePercentage = (count: number) => {
  if (totalSourceCount.value <= 0) return 0;
  return Math.min(100, Math.round((count / totalSourceCount.value) * 100));
};

const sourceRings = computed(() => [
  {
    labelKey: "myProfile.quota.source_type.active_title",
    count: activeCount.value,
    percentage: getSourcePercentage(activeCount.value),
    radius: 50,
    strokeWidth: 6,
    circumference: 314,
    usesLimit: true,
    ringClass: "text-primary-container",
    countClass: "text-primary-container",
  },
  {
    labelKey: "myProfile.quota.source_type.suspended_title",
    count: suspendedCount.value,
    percentage: Math.max(getSourceSharePercentage(suspendedCount.value), 2),
    radius: 42,
    strokeWidth: 6,
    circumference: 264,
    usesLimit: false,
    ringClass: "text-tertiary-fixed",
    countClass: "text-tertiary-fixed",
  },
  {
    labelKey: "myProfile.quota.source_type.restricted_title",
    count: restrictedCount.value,
    percentage: Math.max(getSourceSharePercentage(restrictedCount.value), 2),
    radius: 34,
    strokeWidth: 6,
    circumference: 214,
    usesLimit: false,
    ringClass: "text-error",
    countClass: "text-error",
  },
]);
</script>

<style scoped>
/* Horizontális görgetősáv elrejtése a karusszelnél, de görgethetőség megtartása */
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}
.hide-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
