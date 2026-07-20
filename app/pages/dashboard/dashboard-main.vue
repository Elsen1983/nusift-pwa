<template>
  <div>
    <!-- REFACTORED: Removed hardcoded #131313 gradients and black borders -->
    <div class="fixed top-[60px] inset-x-0 z-[90]">
      <div
        class="mx-auto w-full max-w-2xl bg-surface/95 backdrop-blur-md shadow-sm border-b border-outline-variant/30"
      >
        <div class="box-border flex w-full min-w-0 flex-col gap-3 px-4 py-3 relative">
          <div class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
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
                v-for="option in visibleDateOptions"
                :key="option.key"
                @click="selectDate(option.key)"
                class="text-[13px] font-bold text-on-surface-variant/90 transition-colors py-1 hover:text-primary-container cursor-pointer"
              >
                {{ $t("dashboard.filters.dates." + option.key) }}
                <span
                  v-if="option.isPro"
                  class="material-symbols-outlined text-[12px] ml-1 align-text-bottom text-primary-container/70"
                >
                  workspace_premium
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
          </div>

          <div class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_6rem] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <div
              class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
              v-click-outside="() => (isSourceDropdownOpen = false)"
            >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.sources_label") }}</span
            >
            <div
              @click="toggleSourceDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span class="font-label font-medium text-on-surface-variant truncate">
                    {{
                      selectedSources.length > 0
                        ? localizedSelectedSources
                        : $t("dashboard.header.all_sources")
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
              v-show="isSourceDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg flex flex-col gap-y-2 p-3 pt-2 max-h-56 overflow-y-auto"
            >
              <div
                @click="selectSource('All Sources')"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedSources.length === 0
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/100',
                ]"
              >
                {{ $t("dashboard.header.all_sources") }}
              </div>
              <div
                v-for="source in availableSources"
                :key="source.id"
                @click="selectSource(source.id)"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedSources.includes(source.id)
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/90',
                ]"
              >
                {{ source.name }}
              </div>
            </div>
          </div>

            <div class="flex w-24 shrink-0 items-center justify-center sm:w-28">
            <!-- REFACTORED: Removed hardcoded shadow and #00E5FF, injected CSS variables -->
            <button
              @click="applyFilters"
              :disabled="!hasPendingFilters || isRefreshing"
              :class="[
                'flex w-full justify-center items-center gap-1.5 px-2 rounded-lg transition-all h-[36px] border min-w-0 sm:px-3',
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
              <span class="font-label font-bold text-[11px] sm:text-xs">{{ $t('dashboard.header.refresh_label') }}</span>
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <main
      class="mx-auto w-full max-w-2xl box-border space-y-2 px-4 pt-[165px]"
      @click="closeArticleInteractions"
    >
      <div
        v-if="!isLoading && filteredArticles.length === 0"
        class="rounded-2xl border border-dashed border-outline-variant/40 bg-surface-container px-5 py-8 text-center"
      >
        <h2 class="font-headline text-base font-bold text-on-surface">
          {{ $t("dashboard.empty.title") }}
        </h2>
        <p class="mt-2 text-sm text-on-surface-variant">
          {{ $t("dashboard.empty.description") }}
        </p>
      </div>

      <div :class="isRefreshing ? 'pointer-events-none opacity-60' : ''">
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
      </div>

      <section v-if="totalPages > 1" class="w-full py-4 flex justify-center">
        <div class="flex w-full md:w-3/4 items-center gap-1 md:gap-1.5 rounded-2xl border border-outline-variant/15 bg-surface-container/90 px-1.5 py-1.5 md:px-2.5 md:py-2 shadow-[0_4px_14px_rgba(0,0,0,0.16)] backdrop-blur-sm">
          <button
            type="button"
            class="inline-flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl border border-outline-variant/10 bg-surface-container-high/70 text-on-surface-variant transition-all duration-200 hover:border-primary-container/25 hover:bg-primary-container/10 hover:text-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="currentPage === 1"
            @click="setPage(currentPage - 1)"
            aria-label="Previous page"
          >
            <span class="material-symbols-outlined text-[16px] md:text-[18px]">chevron_left</span>
          </button>

          <div
            class="flex flex-1 items-center gap-0.5 md:gap-1 text-[11px] md:text-xs font-medium px-0.5 md:px-1"
            :class="totalPages <= 5 ? 'justify-center' : 'justify-between'"
          >
            <template v-for="(item, index) in visiblePageItems" :key="`${item}-${index}`">
              <button
                v-if="item !== 'ellipsis'"
                type="button"
                class="min-w-8 h-8 md:min-w-9 md:h-9 px-2 md:px-3 rounded-xl border border-transparent transition-all duration-200"
                :class="
                  item === currentPage
                    ? 'bg-primary-container text-on-primary-container font-bold shadow-[0_0_10px_rgb(var(--color-primary-container)/0.16)]'
                    : 'text-on-surface-variant hover:text-primary-container hover:bg-primary-container/10 hover:border-primary-container/15'
                "
                @click="setPage(item as number)"
              >
                {{ item }}
              </button>
              <span
                v-else
                class="px-0.5 md:px-1.5 text-on-surface-variant/60 select-none"
                aria-hidden="true"
              >
                …
              </span>
            </template>
          </div>

          <button
            type="button"
            class="inline-flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl border border-outline-variant/10 bg-surface-container-high/70 text-on-surface-variant transition-all duration-200 hover:border-primary-container/25 hover:bg-primary-container/10 hover:text-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="currentPage === totalPages"
            @click="setPage(currentPage + 1)"
            aria-label="Next page"
          >
            <span class="material-symbols-outlined text-[16px] md:text-[18px]">chevron_right</span>
          </button>
        </div>
      </section>

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

const dateOptions = [
  { key: "today", isPro: false },
  { key: "last_24h", isPro: false },
  { key: "last_48h", isPro: true },
  { key: "last_1w", isPro: true },
] as const;

const visibleDateOptions = computed(() =>
  dateOptions.filter((option) => !option.isPro || !isUserFreeTier.value),
);

const defaultDateKey = computed(() =>
  visibleDateOptions.value.find((option) => option.key === "last_24h")?.key ||
  visibleDateOptions.value[0]?.key ||
  "last_24h",
);

const isAllowedDateKey = (key: string) =>
  dateOptions.some((option) => option.key === key && (!option.isPro || !isUserFreeTier.value));

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
  sourceTargetUrl?: string;
  canonicalUrl?: string;
  categoryPathUrl?: string | null;
  date: string;
  score: number;
  isPaywall: boolean;
  tags: string[];
  reasoning: string;
  signals: string[];
}

interface SourceFilterOption {
  id: string;
  type: "ROOT" | "CATEGORY";
  url: string;
  name: string;
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
const availableSources = ref<SourceFilterOption[]>([]);

onMounted(() => {
  void feedStore.fetchFeed();
  void loadAvailableSources();
});


const loadAvailableSources = async () => {
  try {
    const response = await $api<{
      success: boolean;
      sources: Array<{
        id: string;
        type: "ROOT" | "CATEGORY";
        url: string;
        name: string;
        isActive: boolean;
      }>;
    }>("/api/user/sources");

    availableSources.value = (response.sources || [])
      .filter((source) => source.isActive)
      .map((source) => ({
        id: source.id,
        type: source.type,
        url: source.url,
        name: source.name,
      }));
  } catch (error) {
    console.error("Failed to load available sources:", error);
  }
};

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
const isSourceDropdownOpen = ref(false);

const currentSelectedDateKey = ref("last_24h");
const selectedCategories = ref<string[]>([]);
const selectedSources = ref<string[]>([]);

const appliedSelectedDateKey = ref("last_24h");
const appliedSelectedCategories = ref<string[]>([]);
const appliedSelectedSources = ref<string[]>([]);
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

const localizedSelectedSources = computed(() =>
  selectedSources.value
    .map((id) => availableSources.value.find((source) => source.id === id)?.name || id)
    .join(", "),
);

const hasPendingFilters = computed(() => {
  const dateChanged =
    currentSelectedDateKey.value !== appliedSelectedDateKey.value;
  const catChanged =
    JSON.stringify(selectedCategories.value) !==
    JSON.stringify(appliedSelectedCategories.value);
  const sourceChanged =
    JSON.stringify(selectedSources.value) !==
    JSON.stringify(appliedSelectedSources.value);
  return dateChanged || catChanged || sourceChanged;
});

const toggleDateDropdown = () => {
  isDateDropdownOpen.value = !isDateDropdownOpen.value;
  isCategoryDropdownOpen.value = false;
  isSourceDropdownOpen.value = false;
};

const toggleCategoryDropdown = () => {
  isCategoryDropdownOpen.value = !isCategoryDropdownOpen.value;
  isDateDropdownOpen.value = false;
  isSourceDropdownOpen.value = false;
};

const toggleSourceDropdown = () => {
  isSourceDropdownOpen.value = !isSourceDropdownOpen.value;
  isDateDropdownOpen.value = false;
  isCategoryDropdownOpen.value = false;
};

const selectDate = (key: string) => {
  currentSelectedDateKey.value = isAllowedDateKey(key) ? key : defaultDateKey.value;
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

const selectSource = (sourceId: string) => {
  if (sourceId === "All Sources") {
    selectedSources.value = [];
  } else {
    const index = selectedSources.value.indexOf(sourceId);
    if (index === -1) {
      selectedSources.value.push(sourceId);
    } else {
      selectedSources.value.splice(index, 1);
    }
  }
};

const applyFilters = () => {
  if (!hasPendingFilters.value || isRefreshing.value) return;

  isRefreshing.value = true;
  setTimeout(() => {
    appliedSelectedDateKey.value = currentSelectedDateKey.value;
    appliedSelectedCategories.value = [...selectedCategories.value];
    appliedSelectedSources.value = [...selectedSources.value];
    currentPage.value = 1;
    closeArticleInteractions();
    isRefreshing.value = false;
  }, 600);
};

watch(
  [isUserFreeTier, visibleDateOptions],
  () => {
    if (!isAllowedDateKey(currentSelectedDateKey.value)) {
      currentSelectedDateKey.value = defaultDateKey.value;
    }
    if (!isAllowedDateKey(appliedSelectedDateKey.value)) {
      appliedSelectedDateKey.value = defaultDateKey.value;
    }
  },
  { immediate: true },
);

const normalizeFilterUrl = (value?: string | null) =>
  (value || "").replace(/\/+$/, "").toLowerCase();

const matchesAppliedDateFilter = (article: Article) => {
  const articleDate = new Date(article.date);
  if (Number.isNaN(articleDate.getTime())) return false;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = now.getTime() - articleDate.getTime();

  switch (appliedSelectedDateKey.value) {
    case "today":
      return articleDate >= startOfToday;
    case "last_24h":
      return diffMs <= 24 * 60 * 60 * 1000;
    case "last_48h":
      return diffMs <= 48 * 60 * 60 * 1000;
    case "last_1w":
      return diffMs <= 7 * 24 * 60 * 60 * 1000;
    default:
      return true;
  }
};

const matchesAppliedCategoryFilter = (article: Article) => {
  if (appliedSelectedCategories.value.length === 0) return true;
  return article.tags.some((tag) => appliedSelectedCategories.value.includes(tag));
};

const matchesAppliedSourceFilter = (article: Article) => {
  if (appliedSelectedSources.value.length === 0) return true;

  const articleSourceUrl = normalizeFilterUrl(article.sourceUrl);
  const articleSourceTargetUrl = normalizeFilterUrl(article.sourceTargetUrl);
  const articleCategoryPathUrl = normalizeFilterUrl(article.categoryPathUrl);

  return appliedSelectedSources.value.some((selectedSourceId) => {
    const selectedSource = availableSources.value.find((source) => source.id === selectedSourceId);
    if (!selectedSource) return false;

    const selectedUrl = normalizeFilterUrl(selectedSource.url);
    return selectedSource.type === "CATEGORY"
      ? articleCategoryPathUrl === selectedUrl || articleSourceTargetUrl === selectedUrl
      : articleSourceUrl === selectedUrl && articleSourceTargetUrl === articleSourceUrl;
  });
};

const filteredArticles = computed(() =>
  articles.value.filter(
    (article) =>
      matchesAppliedDateFilter(article) &&
      matchesAppliedCategoryFilter(article) &&
      matchesAppliedSourceFilter(article),
  ),
);

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredArticles.value.length / ARTICLES_PER_PAGE)),
);

const paginatedArticles = computed(() => {
  const start = (currentPage.value - 1) * ARTICLES_PER_PAGE;
  return filteredArticles.value.slice(start, start + ARTICLES_PER_PAGE);
});

const visiblePageItems = computed(() => {
  const total = totalPages.value;
  const current = currentPage.value;

  if (total <= 5) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  if (current <= 2 || current >= total - 1) {
    return [1, 2, "ellipsis", total - 1, total];
  }

  return [1, 2, "ellipsis", current, "ellipsis", total - 1, total];
});

const setPage = (page: number) => {
  currentPage.value = Math.min(Math.max(page, 1), totalPages.value);
  activeActionMenu.value = null;
  activeOverlay.value = null;
  if (import.meta.client) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
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
  () => filteredArticles.value.length,
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
  const targetUrl =
    activeArticleData.value?.canonicalUrl || activeArticleData.value?.sourceUrl;
  if (import.meta.client && targetUrl) {
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  }
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
