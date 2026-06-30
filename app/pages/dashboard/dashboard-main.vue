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
      <p
        v-if="feedError"
        class="text-center text-sm text-semantic-paywall py-8"
      >
        {{ feedError }}
      </p>
      <p
        v-else-if="!isRefreshing && articles.length === 0"
        class="text-center text-sm text-on-surface-variant py-8"
      >
        No articles yet. Run RSS ingest after subscribing to sources.
      </p>

      <NewsCard
        v-for="article in articles"
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

      <section class="flex justify-center items-center gap-2 py-4">
        <div class="flex items-center gap-3 text-xs font-medium">
          <!-- REFACTORED: text-[#00E5FF] changed to text-primary-container -->
          <button class="text-primary-container font-bold transition-colors">1</button>
          <span class="text-outline-variant/30 text-[10px]">|</span>
          <button
            class="text-on-surface-variant hover:text-primary-container transition-colors"
          >
            2
          </button>
          <span class="text-outline-variant/30 text-[10px]">|</span>
          <button
            class="text-on-surface-variant hover:text-primary-container transition-colors"
          >
            3
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
import { $api } from "~/utils/api";

const { t } = useI18n();
const authStore = useAuthStore();

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

const articles = ref<Article[]>([]);
const feedError = ref<string | null>(null);
const feedTotal = ref(0);

const fetchFeed = async () => {
  feedError.value = null;
  isRefreshing.value = true;
  try {
    const response = await $fetch<{
      items: Article[];
      total: number;
    }>("/api/feed", {
      query: {
        window: appliedSelectedDateKey.value,
        limit: 20,
        offset: 0,
      },
    });
    articles.value = response.items;
    feedTotal.value = response.total;
  } catch (error) {
    console.error("Failed to load feed:", error);
    feedError.value = "Failed to load feed.";
    articles.value = [];
    feedTotal.value = 0;
  } finally {
    isRefreshing.value = false;
  }
};

onMounted(() => {
  void fetchFeed();
});

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

const applyFilters = async () => {
  if (!hasPendingFilters.value || isRefreshing.value) return;
  appliedSelectedDateKey.value = currentSelectedDateKey.value;
  appliedSelectedCategories.value = [...selectedCategories.value];
  await fetchFeed();
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