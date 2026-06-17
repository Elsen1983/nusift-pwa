<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-4 pb-20 overflow-hidden">
    <section class="flex items-center gap-4 px-2">
      <div
        class="w-16 h-16 rounded-full border border-primary-container/30 p-0.5 shrink-0 shadow-[0_0_15px_rgba(0,229,255,0.1)]"
      >
        <img
          :src="userAvatar"
          class="w-full h-full object-cover rounded-full"
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
          class="w-full flex items-center justify-between p-4 hover:bg-surface-container-highest transition-colors group outline-none"
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

        <div v-show="openMenu === 'account'" class="py-3 px-3 border-t border-outline-variant/10 bg-surface-container-lowest/50">
          <AccountSettingsForm />
        </div>

        <div class="h-px w-full bg-outline-variant/10"></div>

        <button
          @click="toggleMenu('subscription')"
          class="w-full flex items-center justify-between p-4 hover:bg-surface-container-highest transition-colors group outline-none"
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
          class="w-full flex items-center justify-between p-4 hover:bg-surface-container-highest transition-colors group outline-none"
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

    <!-- PREFERENCE SETTINGS -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("myProfile.sections.preference") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl p-2 border border-outline-variant/10 shadow-lg"
      >
        <button
          class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group"
        >
          <div class="flex items-center gap-4 text-on-surface">
            <span
              class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors"
              >language</span
            >
            <span class="font-body text-[15px] font-medium">{{
              $t("myProfile.menu.language")
            }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-on-surface-variant text-[13px] font-label"
              >English</span
            >
            <span
              class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors"
              >chevron_right</span
            >
          </div>
        </button>

        <div class="w-full flex items-center justify-between p-3.5 rounded-2xl">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant"
              >dark_mode</span
            >
            <span class="font-body text-[15px] font-medium">{{
              $t("myProfile.menu.dark_mode")
            }}</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              v-model="isDarkMode"
              class="sr-only peer"
              disabled
            />
            <div
              class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"
            ></div>
          </label>
        </div>
      </div>
    </section>

    <!-- SOURCE METRICS -->
    <section class="space-y-2">
      <h4
        class="text-[10px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-5"
      >
        {{ $t("myProfile.sections.sources") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl p-5 border border-outline-variant/10 shadow-lg relative overflow-hidden"
      >
        <div
          class="absolute -left-10 -top-10 w-40 h-40 bg-primary-container/5 blur-3xl rounded-full pointer-events-none"
        ></div>
        <h4
          class="text-[10px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-0 align-self-start mt-2 mb-3"
        >
          {{ $t("myProfile.sections.sources") }}
        </h4>
        <div
          class="relative z-10 flex flex-col md:flex-row gap-6 md:gap-4 items-center w-full"
        >
          <div
            class="flex items-center gap-5 shrink-0 w-full md:w-auto justify-center md:justify-start"
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

          <div
            class="w-full md:flex-1 min-w-0 md:pl-6 md:border-l border-outline-variant/10 pt-4 md:pt-0 border-t md:border-t-0 mt-2 md:mt-0"
          >
            <SourceTimelineChart
              :timeline-data="rawTimelineData"
              :is-loading="isAnalyticsLoading"
            />
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
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useAuthStore } from "~/stores/auth";
import { $api } from "~/utils/api";
import defaultAvatar from "~/assets/images/default_avatar.png";
import SourceTimelineChart from "~/components/SourceTimelineChart.vue";

definePageMeta({
  layout: "app-layout",
});

const authStore = useAuthStore();
const userAvatar = computed(
  () => authStore.user?.profile?.avatarUrl || (authStore.user?.profile as any)?.avatar || defaultAvatar,
);
const isPro = computed(() => authStore.user?.tier === "PRO");
// --- MOCK DATA ---
// Ezeket később egy API végpontról (`/api/user/analytics`) fogjuk behúzni
const activeCount = ref(0);
const suspendedCount = ref(0);
const restrictedCount = ref(0);
const limit = ref(5);
const isDarkMode = ref(true);

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
onMounted(async () => {
  try {
    const [sourcesResponse, analyticsResponse] = await Promise.all([
      $api<any>("/api/user/sources"),
      $api<any>("/api/user/analytics"), // Az új, kibővített endpointod
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

    if (analyticsResponse && analyticsResponse.success) {
      console.log("Analytics API response:", analyticsResponse); // Debug log az API válaszról

      if (analyticsResponse.data) {
        console.log(
          "Received timeline data from analytics API:",
          analyticsResponse.data,
        ); // Debug log a timeline adatokkal
        rawTimelineData.value = analyticsResponse.data; // Átadjuk a prop-nak
      } else {
        console.warn("Analytics API válasz nem tartalmaz 'data' mezőt.");
      }

      // Valós metrikák bekötése az új API válaszból
      if (analyticsResponse.metrics) {
        console.log(
          "Received metrics from analytics API:",
          analyticsResponse.metrics,
        ); // Debug log a metrikákról
        articlesStateMetrics.value = {
          readArticles: analyticsResponse.metrics.read,
          savedArticles: analyticsResponse.metrics.saved,
          sharedArticles: analyticsResponse.metrics.shared,
          rejectedArticles: analyticsResponse.metrics.rejected,
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
  }
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
