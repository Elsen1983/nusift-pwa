<template>
  <div>
    <!-- REFACTORED: Removed hardcoded #131313 gradients and black borders -->
    <div
      class="fixed top-[60px] inset-x-0 mx-auto w-full max-w-2xl bg-surface/95 backdrop-blur-md shadow-sm z-[90] border-b border-outline-variant/30"
    >
      <div class="px-4 py-3 flex gap-3 flex-row relative">
        <div class="flex items-end gap-3 w-full">
          <div
            class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
            v-click-outside="() => (isDateDropdownOpen = false)"
          >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.date_label") }}</span
            >
            <!-- REFACTORED: Removed #00E5FF outline/border, using primary-container -->
            <div
              @click="toggleDateDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                    >{{
                      $t("dashboard.filters.dates." + currentSelectedDateKey)
                    }}</span
                  >
                  <span
                    class="material-symbols-outlined text-[18px] text-primary-container flex-shrink-0 ml-2"
                    >expand_more</span
                  >
                </div>
              </div>
            </div>
            <div
              v-show="isDateDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg space-y-1 p-3 pt-2"
            >
              <div
                v-for="option in dateOptions"
                :key="option.key"
                @click="
                  !(option.isPro && isUserFreeTier) && selectDate(option.key)
                "
                :class="[
                  'text-[13px] font-bold transition-colors py-1',
                  option.isPro && isUserFreeTier
                    ? 'text-on-surface-variant/30 cursor-not-allowed italic'
                    : 'text-on-surface-variant/90 hover:text-primary-container cursor-pointer',
                ]"
              >
                {{ $t("dashboard.filters.dates." + option.key) }}
                <span
                  v-if="option.isPro && isUserFreeTier"
                  class="material-symbols-outlined text-[12px] ml-1 align-text-bottom"
                >
                  lock
                </span>
              </div>
            </div>
          </div>

          <div
            class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
            v-click-outside="() => (isCategoryDropdownOpen = false)"
          >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.categories_label") }}</span
            >
            <!-- REFACTORED: Removed #00E5FF outline/border -->
            <div
              @click="toggleCategoryDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                  >
                    {{
                      selectedCategories.length > 0
                        ? localizedSelectedCategories
                        : $t("dashboard.header.all_categories")
                    }}
                  </span>
                  <span
                    class="material-symbols-outlined text-[18px] text-primary-container flex-shrink-0 ml-2"
                    >expand_more</span
                  >
                </div>
              </div>
            </div>
            <div
              v-show="isCategoryDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg flex flex-col gap-y-2 p-3 pt-2 max-h-48 overflow-y-auto"
            >
              <!-- REFACTORED: text-[#00E5FF] changed to text-primary-container -->
              <div
                @click="selectCategory('All Categories')"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.length === 0
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/100',
                ]"
              >
                {{ $t("dashboard.header.all_categories") }}
              </div>
              <div
                v-for="cat in availableCategories"
                :key="cat.key"
                @click="selectCategory(cat.value)"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.includes(cat.value)
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/90',
                ]"
              >
                {{ $t("dashboard.filters.categories." + cat.key) }}
              </div>
            </div>
          </div>

          <div class="flex-shrink-0 flex items-center justify-center">
            <!-- REFACTORED: Removed hardcoded shadow and #00E5FF, injected CSS variables -->
            <button
              @click="applyFilters"
              :disabled="!hasPendingFilters || isRefreshing"
              :class="[
                'flex justify-center items-center p-2 rounded-lg transition-all h-[36px] w-[36px] border',
                hasPendingFilters
                  ? 'bg-surface-container-highest text-primary-container border-primary-container/30 shadow-[0_0_12px_rgb(var(--color-primary-container)/0.15)] hover:bg-surface-bright'
                  : 'bg-surface-container-highest text-on-surface-variant/50 border-transparent disabled:opacity-50 disabled:cursor-not-allowed',
              ]"
            >
              <span
                :class="[
                  'material-symbols-outlined text-[18px]',
                  { 'animate-spin': isRefreshing },
                ]"
                >refresh</span
              >
            </button>
          </div>
        </div>
      </div>
    </div>

    <main
      class="px-4 space-y-2 max-w-2xl mx-auto pt-[90px]"
      @click="closeArticleInteractions"
    >
      <div
        v-if="!isLoading && articles.length === 0"
        class="rounded-2xl border border-dashed border-outline-variant/40 bg-surface-container px-5 py-8 text-center"
      >
        <h2 class="font-headline text-base font-bold text-on-surface">
          {{ $t("dashboard.empty.title") }}
        </h2>
        <p class="mt-2 text-sm text-on-surface-variant">
          {{ $t("dashboard.empty.description") }}
        </p>
      </div>

      <div
        v-if="toast.show"
        class="fixed bottom-4 left-1/2 z-[120] w-[min(92vw,28rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md"
        :class="toastClass"
      >
        <div class="flex items-start gap-3">
          <span class="material-symbols-outlined text-[20px] mt-0.5">{{ toastIcon }}</span>
          <p class="text-sm font-medium leading-snug">{{ toast.message }}</p>
        </div>
      </div>

      <NewsCard
        v-for="article in paginatedArticles"
        :key="article.id"
        :article="article"
        :activeActionMenu="activeActionMenu"
        :activeOverlay="activeOverlay"
        @readNow="handleReadNow"
        @toggleMenu="toggleActionMenu"
        @openOverlay="openOverlay"
        @openRating="openRatingModal"
        style="margin-bottom: 0.75rem !important;"
      />

      <section v-if="totalPages > 1" class="flex justify-center items-center gap-2 py-4">
        <div class="flex items-center gap-3 text-xs font-medium">
          <button
            v-for="page in visiblePageNumbers"
            :key="page"
            class="transition-colors"
            :class="
              page === currentPage
                ? 'text-primary-container font-bold'
                : 'text-on-surface-variant hover:text-primary-container'
            "
            @click="setPage(page)"
          >
            {{ page }}
          </button>
        </div>
      </section>

      <div
        v-if="isDev"
        class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4 space-y-4"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Dev pipeline trigger
              </h3>
              <span
                class="rounded-full border border-primary-container/30 bg-primary-container/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-container"
              >
                Dev only
              </span>
            </div>
            <p class="mt-1 text-xs text-on-surface-variant">
              Manually run the news pipeline and refresh the feed.
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              @click="reimportRss"
              :disabled="isImportingRss"
              class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isImportingRss ? "Importing..." : "Reimport RSS" }}
            </button>
            <button
              @click="fixRssStatus"
              :disabled="isFixingRssStatus"
              class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isFixingRssStatus ? "Fixing..." : "Fix RSS status" }}
            </button>
            <button
              @click="runManualPipeline"
              :disabled="isPipelineRunning"
              class="rounded-lg bg-primary-container px-4 py-2 text-sm font-bold text-on-primary-container transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isPipelineRunning ? "Running..." : "Run pipeline" }}
            </button>
          </div>
        </div>

        <div class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h4 class="font-headline text-sm font-bold text-on-surface">
                Agent logs
              </h4>
              <p class="mt-1 text-xs text-on-surface-variant">
                Recent backend pipeline activity.
              </p>
              <p class="mt-1 text-[11px] text-on-surface-variant">
                {{ agentSourceCount }} user-linked source(s) currently eligible for pipeline runs.
              </p>
              <p v-if="rssReimportProgressText" class="mt-1 text-[11px] font-medium text-sky-200">
                {{ rssReimportProgressText }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                @click="loadAgentLogs"
                class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
              >
                Refresh logs
              </button>
              <button
                @click="clearAgentLogs"
                :disabled="isClearingLogs"
                class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isClearingLogs ? "Clearing..." : "Clear pipeline" }}
              </button>
            </div>
          </div>

          <div v-if="agentLogs.length === 0" class="mt-3 text-xs text-on-surface-variant">
            No agent logs yet.
          </div>

          <div v-else class="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
            <div
              v-for="log in agentLogs"
              :key="log.id"
              class="rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-bold text-on-surface">{{ log.status }}</span>
                    <span v-if="log.sourceId" class="text-[10px] text-on-surface-variant">source: {{ log.sourceId }}</span>
                  </div>
                  <p class="mt-1 text-xs text-on-surface-variant line-clamp-2">
                    {{ log.errorLog || "No details." }}
                  </p>
                </div>
                <div class="text-right text-[10px] text-on-surface-variant shrink-0">
                  <div>{{ formatLogTime(log.createdAt) }}</div>
                  <div>{{ log.executionTimeMs }}ms</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <PaywallModal
        v-model="showPaywallModal"
        @browser="openInBrowser"
        @read="openReaderFromModal"
      />

      <ArticleReaderModal
        v-model="showReaderModal"
        :article="activeArticleData"
        :content="readerContent"
        @browser="openInBrowser"
      />

      <RatingModal
        v-model="showRatingModal"
        :initialScore="activeRatingInitialScore"
        @confirm="handleConfirmRating"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useFeedStore } from "~/stores/feedStore";
import { $api } from "~/utils/api";

const { t } = useI18n();
const authStore = useAuthStore();
const feedStore = useFeedStore();

const isUserFreeTier = computed(() => {
  return !authStore.user?.tier || authStore.user.tier === "FREE";
});

definePageMeta({
  layout: "app-layout",
});

interface InterestNode {
  id: string;
  name: string;
  weight?: number;
  prompt?: string;
  chips?: any[];
}

interface Article {
  id: number;
  title: string;
  source: string;
  sourceUrl?: string;
  date: string;
  score: number;
  isPaywall: boolean;
  tags: string[];
  reasoning: string;
  signals: string[];
}

const vClickOutside = {
  mounted(el: any, binding: any) {
    el.clickOutsideEvent = function (event: Event) {
      if (!(el === event.target || el.contains(event.target))) {
        binding.value(event, el);
      }
    };
    document.body.addEventListener("click", el.clickOutsideEvent);
  },
  unmounted(el: any) {
    document.body.removeEventListener("click", el.clickOutsideEvent);
  },
};

const articles = computed(() => feedStore.articles as Article[]);
const isLoading = computed(() => feedStore.isLoading);
const ARTICLES_PER_PAGE = 10;
const currentPage = ref(1);
const isPipelineRunning = ref(false);
const isFixingRssStatus = ref(false);
const isImportingRss = ref(false);
const isDev = import.meta.env.DEV;
const isClearingLogs = ref(false);
const agentLogs = ref<Array<{ id: string; status: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }>>([]);
const agentSourceCount = ref(0);
const toast = ref({ show: false, message: "", type: "success" as "success" | "error" });

const toastClass = computed(() =>
  toast.value.type === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100",
);

const toastIcon = computed(() => (toast.value.type === "success" ? "check_circle" : "error"));
let devPanelPollTimer: ReturnType<typeof window.setInterval> | null = null;
const DEV_PANEL_POLL_MS = 10000;

const rssReimportProgressText = computed(() => {
  const currentLog = agentLogs.value.find((log) =>
    ["RSS_REIMPORT_STARTED", "RSS_REIMPORT_PROGRESS", "RSS_REIMPORT_FINISHED"].includes(log.status),
  );

  if (!currentLog) return "";

  if (currentLog.status === "RSS_REIMPORT_FINISHED") {
    return `Last reimport: ${currentLog.errorLog || "completed."}`;
  }

  if (currentLog.status === "RSS_REIMPORT_STARTED") {
    return currentLog.errorLog || "RSS reimport started.";
  }

  return currentLog.errorLog || "";
});

const startDevPanelPolling = () => {
  if (!import.meta.client || devPanelPollTimer) return;
  devPanelPollTimer = window.setInterval(() => {
    void refreshDevPanel();
  }, DEV_PANEL_POLL_MS);
};

const stopDevPanelPolling = () => {
  if (!import.meta.client || !devPanelPollTimer) return;
  window.clearInterval(devPanelPollTimer);
  devPanelPollTimer = null;
};

onMounted(() => {
  if (feedStore.articles.length === 0) {
    feedStore.fetchFeed();
  }
  if (isDev) {
    void refreshDevPanel();
  }
});

const formatLogTime = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const loadAgentLogs = async () => {
  if (!isDev) return;
  try {
    const response = await $api<{ ok: boolean; logs: Array<{ id: string; status: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }> }>("/api/dev/agent-logs");
    agentLogs.value = response.logs || [];
  } catch (error: any) {
    if (error?.response?.status === 429 || error?.status === 429) return;
    throw error;
  }
};

const loadEligibleSourceCount = async () => {
  if (!isDev) return;
  try {
    const response = await $api<{ ok: boolean; count: number }>("/api/dev/agent-source-count");
    agentSourceCount.value = response.count || 0;
  } catch (error: any) {
    if (error?.response?.status === 429 || error?.status === 429) return;
    throw error;
  }
};

const refreshDevPanel = async () => {
  try {
    await Promise.all([loadAgentLogs(), loadEligibleSourceCount()]);
  } catch (error) {
    console.error("Failed to refresh dev panel:", error);
  }
};

const totalPages = computed(() =>
  Math.max(1, Math.ceil(articles.value.length / ARTICLES_PER_PAGE)),
);

const paginatedArticles = computed(() => {
  const start = (currentPage.value - 1) * ARTICLES_PER_PAGE;
  return articles.value.slice(start, start + ARTICLES_PER_PAGE);
});

const visiblePageNumbers = computed(() => {
  const pages: number[] = [];
  for (let i = 1; i <= totalPages.value; i += 1) {
    pages.push(i);
  }
  return pages;
});

const setPage = (page: number) => {
  currentPage.value = Math.min(Math.max(page, 1), totalPages.value);
  activeActionMenu.value = null;
  activeOverlay.value = null;
  if (import.meta.client) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
};

const fixRssStatus = async () => {
  if (isFixingRssStatus.value) return;

  isFixingRssStatus.value = true;
  try {
    const response = await $api<{ ok: boolean; fixedCount: number }>("/api/dev/fix-rss-status", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Fixed ${response.fixedCount ?? 0} source RSS status record(s).`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Failed to fix RSS status records.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isFixingRssStatus.value = false;
  }
};

const reimportRss = async () => {
  if (isImportingRss.value) return;

  isImportingRss.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      success: boolean;
      message: string;
      created: number;
      updated: number;
      patched: number;
      verifiedActive: number;
      verifiedFailed: number;
      verifiedNoRss: number;
    }>("/api/dev/import-rss", {
      method: "GET",
    });
    toast.value = {
      show: true,
      message:
        response.message ||
        `RSS import completed. Created ${response.created}, patched ${response.patched}, active ${response.verifiedActive}.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "RSS import failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isImportingRss.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const clearAgentLogs = async () => {
  if (!isDev || isClearingLogs.value) return;
  isClearingLogs.value = true;
  try {
    const response = await $api<{ ok: boolean; deletedCount: number; articleCount?: number }>("/api/dev/agent-logs", {
      method: "DELETE",
    });
    agentLogs.value = [];
    await feedStore.fetchFeed();
    toast.value = {
      show: true,
      message: `Cleared ${response.articleCount ?? 0} article(s) and ${response.deletedCount ?? 0} agent log(s).`,
      type: "success",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Failed to clear logs.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isClearingLogs.value = false;
  }
};

const runManualPipeline = async () => {
  if (isPipelineRunning.value) return;

  isPipelineRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{ ok: boolean; result?: any }>("/api/dev/run-news-pipeline", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Pipeline finished: ${response.result?.inserted ?? 0} inserted, ${response.result?.skipped ?? 0} skipped, ${response.result?.failed ?? 0} failed.`,
      type: "success",
    };
    await feedStore.fetchFeed();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3500);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Pipeline run failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isPipelineRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const dateOptions = [
  { key: "today", value: "Today", isPro: false },
  { key: "last_48h", value: "Last 48h (Free)", isPro: false },
  { key: "last_1w", value: "Last 1 Week (Pro)", isPro: true },
  { key: "last_2w", value: "Last 2 Week (Pro)", isPro: true },
];

const availableCategories = computed<{ key: string; value: string }[]>(() => {
  if (!authStore.user?.topInterests) return [];

  type CategoryOption = { key: string; value: string };

  const mappedCategories: CategoryOption[] = authStore.user.topInterests.map((interest: InterestNode) => ({
    key: interest.id,
    value: interest.name
  }));

  return mappedCategories.sort((a: CategoryOption, b: CategoryOption) => {
    const translatedA = t(`dashboard.filters.categories.${a.key}`);
    const translatedB = t(`dashboard.filters.categories.${b.key}`);
    
    return translatedA.localeCompare(translatedB);
  });
});

const isDateDropdownOpen = ref(false);
const isCategoryDropdownOpen = ref(false);

const currentSelectedDateKey = ref("today");
const selectedCategories = ref<string[]>([]);

const appliedSelectedDateKey = ref("today");
const appliedSelectedCategories = ref<string[]>([]);
const isRefreshing = ref(false);

const localizedSelectedCategories = computed(() => {
  return selectedCategories.value
    .map((val) => {
      const matchedCategory = availableCategories.value.find(
        (c: { key: string; value: string }) => c.value === val,
      );
      return matchedCategory
        ? t(`dashboard.filters.categories.${matchedCategory.key}`)
        : val;
    })
    .join(", ");
});

const hasPendingFilters = computed(() => {
  const dateChanged =
    currentSelectedDateKey.value !== appliedSelectedDateKey.value;
  const catChanged =
    JSON.stringify(selectedCategories.value) !==
    JSON.stringify(appliedSelectedCategories.value);
  return dateChanged || catChanged;
});

const toggleDateDropdown = () => {
  isDateDropdownOpen.value = !isDateDropdownOpen.value;
  isCategoryDropdownOpen.value = false;
};

const toggleCategoryDropdown = () => {
  isCategoryDropdownOpen.value = !isCategoryDropdownOpen.value;
  isDateDropdownOpen.value = false;
};

const selectDate = (key: string) => {
  currentSelectedDateKey.value = key;
  isDateDropdownOpen.value = false;
};

const selectCategory = (catValue: string) => {
  if (catValue === "All Categories") {
    selectedCategories.value = [];
  } else {
    const index = selectedCategories.value.indexOf(catValue);
    if (index === -1) {
      selectedCategories.value.push(catValue);
    } else {
      selectedCategories.value.splice(index, 1);
    }
  }
};

const applyFilters = () => {
  if (!hasPendingFilters.value || isRefreshing.value) return;

  isRefreshing.value = true;
  setTimeout(() => {
    appliedSelectedDateKey.value = currentSelectedDateKey.value;
    appliedSelectedCategories.value = [...selectedCategories.value];
    isRefreshing.value = false;
  }, 600);
};

const activeActionMenu = ref<number | null>(null);
const activeOverlay = ref<number | null>(null);

const closeArticleInteractions = () => {
  activeActionMenu.value = null;
  activeOverlay.value = null;
};

const toggleActionMenu = (id: number) => {
  if (activeOverlay.value === id) {
    activeOverlay.value = null;
    activeActionMenu.value = id;
  } else {
    activeOverlay.value = null;
    activeActionMenu.value = activeActionMenu.value === id ? null : id;
  }
};

watch(
  () => articles.value.length,
  () => {
    if (currentPage.value > totalPages.value) {
      currentPage.value = totalPages.value;
    }
  },
);

const openOverlay = (id: number) => {
  activeActionMenu.value = null;
  activeOverlay.value = id;
};

const showPaywallModal = ref(false);
const showReaderModal = ref(false);
const activeArticleData = ref<any>(null);
const showRatingModal = ref(false);
const activeRatingArticleId = ref<number | null>(null);

const loremIpsum = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.",
  "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.",
  "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione.",
];

const readerContent = computed(() => {
  if (!activeArticleData.value) return "";
  if (activeArticleData.value.isPaywall) {
    return `<p>${loremIpsum[0]}</p><p>${loremIpsum[1]}</p><p class="opacity-30 pb-40">${loremIpsum[2]}</p>`;
  }
  return loremIpsum.map((p) => `<p>${p}</p>`).join("");
});

const handleReadNow = (article: any) => {
  activeArticleData.value = article;
  if (article.isPaywall) {
    showPaywallModal.value = true;
  } else {
    showReaderModal.value = true;
    document.body.style.overflow = "hidden";
  }
};

const openReaderFromModal = () => {
  showPaywallModal.value = false;
  setTimeout(() => {
    showReaderModal.value = true;
    document.body.style.overflow = "hidden";
  }, 300);
};

const openInBrowser = () => {
  alert("Opening in system default browser...");
  showPaywallModal.value = false;
};

const activeRatingInitialScore = computed(() => {
  if (!activeRatingArticleId.value) return 0;
  const article = articles.value.find(
    (a) => a.id === activeRatingArticleId.value,
  );
  return article ? article.score : 0;
});

const openRatingModal = (id: number) => {
  activeRatingArticleId.value = id;
  showRatingModal.value = true;
  activeActionMenu.value = null;
};

const handleConfirmRating = (newScore: number) => {
  const articleIndex = articles.value.findIndex(
    (a) => a.id === activeRatingArticleId.value,
  );
  if (articleIndex !== -1) {
    const targetArticle = articles.value[articleIndex];
    if (targetArticle) {
      targetArticle.score = newScore;
    }
  }
};

watch(
  [showPaywallModal, showReaderModal, showRatingModal],
  ([newPaywall, newReader, newRating]) => {
    if (newPaywall || newReader || newRating) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
  },
);
</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
