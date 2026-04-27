<template>
  <div>
    <div
      class="fixed top-[60px] left-0 w-full bg-gradient-to-b from-[#131313] via-[#131313] to-surface-container-low shadow-[0_8px_16px_-4px_rgba(0,0,0,0.3)] z-[90] border-b border-black"
    >
      <nav class="px-4 py-3 flex gap-3 flex-row relative">
        <div class="flex items-end gap-3 w-full">
          <div
            class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
            v-click-outside="() => (isDateDropdownOpen = false)"
          >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >Date</span
            >
            <div
              @click="toggleDateDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-2.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px]"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                    >{{ currentSelectedDate }}</span
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
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-2xl bg-surface-container-highest border border-outline-variant/30 rounded-lg space-y-1 p-3 pt-2"
            >
              <div
                v-for="option in dateOptions"
                :key="option"
                @click="selectDate(option)"
                class="text-[13px] text-on-surface-variant/70 hover:text-primary-container transition-colors py-1 cursor-pointer"
              >
                {{ option }}
              </div>
            </div>
          </div>

          <div
            class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
            v-click-outside="() => (isCategoryDropdownOpen = false)"
          >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >Categories</span
            >
            <div
              @click="toggleCategoryDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-2.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px]"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                  >
                    {{
                      selectedCategories.length > 0
                        ? selectedCategories.join(", ")
                        : "All Categories"
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
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-2xl bg-surface-container-highest border border-outline-variant/30 rounded-lg flex flex-col gap-y-2 p-3 pt-2 max-h-48 overflow-y-auto"
            >
              <div
                @click="selectCategory('All Categories')"
                :class="[
                  'text-[13px] hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.length === 0
                    ? 'text-[#00E5FF]'
                    : 'text-on-surface-variant/70',
                ]"
              >
                All Categories
              </div>
              <div
                v-for="cat in availableCategories"
                :key="cat"
                @click="selectCategory(cat)"
                :class="[
                  'text-[13px] hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.includes(cat)
                    ? 'text-[#00E5FF]'
                    : 'text-on-surface-variant/70',
                ]"
              >
                {{ cat }}
              </div>
            </div>
          </div>

          <div class="flex-shrink-0 flex items-center justify-center">
            <button
              @click="applyFilters"
              :disabled="!hasPendingFilters || isRefreshing"
              :class="[
                'flex justify-center items-center p-2 rounded-lg transition-all h-[36px] w-[36px] border',
                hasPendingFilters
                  ? 'bg-surface-container-highest text-[#00E5FF] border-[#00E5FF]/30 shadow-[0_0_12px_rgba(0,229,255,0.15)] hover:bg-surface-bright'
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
      </nav>
    </div>

    <main
      class="px-4 space-y-3 max-w-2xl mx-auto pt-[90px]"
      @click="closeArticleInteractions"
    >
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
      />

      <section class="flex justify-center items-center gap-2 py-4">
        <div class="flex items-center gap-3 text-xs font-medium">
          <button class="text-[#00E5FF] font-bold transition-colors">1</button>
          <span class="text-outline-variant/30 text-[10px]">|</span>
          <button class="text-on-surface-variant hover:text-[#00E5FF] transition-colors">2</button>
          <span class="text-outline-variant/30 text-[10px]">|</span>
          <button class="text-on-surface-variant hover:text-[#00E5FF] transition-colors">3</button>
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
import { ref, computed, watch } from "vue";

// Define the layout constraint
definePageMeta({
  layout: "app-layout",
});

// --- Directives ---
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

// --- Mock Data ---
const articles = ref([
  {
    id: 1,
    title: "Global Energy Shifts: Rise of Decentralized Power Grids",
    source: "reuters.com",
    date: "24 OCT 2023",
    score: 9,
    isPaywall: true,
    tags: ["Energy Sector", "Infrastructure"],
    reasoning:
      "Prioritized based on your interest in decentralized infrastructure trends and historical engagement levels.",
    signals: [
      "Significant shift in renewable energy policy in the EU.",
      "New funding for decentralized grid infrastructure projects.",
      "Potential for cross-border energy trading protocols.",
    ],
  },
  {
    id: 2,
    title: "The Evolution of AI Agents in Decentralized Markets",
    source: "wired.com",
    date: "22 OCT 2023",
    score: 9,
    isPaywall: false,
    tags: ["React Nuance"],
    reasoning:
      "Direct relevance to your current project on autonomous sift protocols and agent logic.",
    signals: [
      "Emergence of highly autonomous negotiation agents.",
      "Integration of LLMs in financial smart contracts.",
    ],
  },
  {
    id: 3,
    title: "Major Tech Hub Approved for Bandon with NuSift Protocol",
    source: "bandonnews.ie",
    date: "24 OCT 2023",
    score: 8,
    isPaywall: true,
    tags: ["Bandon Market node", "Infrastructure"],
    reasoning:
      "High correlation with Bandon Market protocol updates and infrastructure development in followed tech nodes.",
    signals: [
      "First major tech hub approval in West Cork region.",
      "NuSift protocol selected for secure data exchange.",
      "Impact on local tech node infrastructure development.",
    ],
  },
  {
    id: 4,
    title: "Quantum Computing Breakthrough in Atom Trapping",
    source: "science-nature.org",
    date: "23 OCT 2023",
    score: 7,
    isPaywall: false,
    tags: ["Quantum Tech"],
    reasoning:
      "Significant breakthrough in Physics nodes that precede major shifts in your technical stack.",
    signals: [
      "Breakthrough in stable atom trapping at room temperature.",
      "Potential to scale quantum processors for niche industrial use.",
    ],
  },
  {
    id: 5,
    title: "New Privacy Regulations Proposed for EU Tech Nodes",
    source: "techcrunch.com",
    date: "23 OCT 2023",
    score: 6,
    isPaywall: true,
    tags: ["EU Compliance"],
    reasoning:
      "Impacts your data compliance modules and cross-border protocol developments.",
    signals: [
      "Stricter data residency requirements proposed for 2024.",
      "Potential conflict with current cross-border data transfer protocols.",
      "EU compliance framework update expected in Q1.",
    ],
  },
]);

// --- Filter State ---
const dateOptions = [
  "Today",
  "Last 48h (Free)",
  "Last 1 Week (Pro)",
  "Last 2 Week (Pro)",
];
const availableCategories = [
  "Politics",
  "Technology",
  "Economy",
  "Health",
  "Science",
  "Sports",
  "Entertainment",
  "World",
  "Environment",
  "Lifestyle",
];

const isDateDropdownOpen = ref(false);
const isCategoryDropdownOpen = ref(false);

const currentSelectedDate = ref("Today");
const selectedCategories = ref<string[]>([]);

// Applied states for the refresh button logic
const appliedSelectedDate = ref("Today");
const appliedSelectedCategories = ref<string[]>([]);
const isRefreshing = ref(false);

const hasPendingFilters = computed(() => {
  const dateChanged = currentSelectedDate.value !== appliedSelectedDate.value;
  const catChanged =
    JSON.stringify(selectedCategories.value) !==
    JSON.stringify(appliedSelectedCategories.value);
  return dateChanged || catChanged;
});

// --- Filter Methods ---
const toggleDateDropdown = () => {
  isDateDropdownOpen.value = !isDateDropdownOpen.value;
  isCategoryDropdownOpen.value = false;
};

const toggleCategoryDropdown = () => {
  isCategoryDropdownOpen.value = !isCategoryDropdownOpen.value;
  isDateDropdownOpen.value = false;
};

const closeAllDropdowns = () => {
  isDateDropdownOpen.value = false;
  isCategoryDropdownOpen.value = false;
};

const selectDate = (option: string) => {
  currentSelectedDate.value = option;
  isDateDropdownOpen.value = false;
};

const selectCategory = (cat: string) => {
  if (cat === "All Categories") {
    selectedCategories.value = [];
  } else {
    const index = selectedCategories.value.indexOf(cat);
    if (index === -1) {
      selectedCategories.value.push(cat);
    } else {
      selectedCategories.value.splice(index, 1);
    }
  }
};

const applyFilters = () => {
  if (!hasPendingFilters.value || isRefreshing.value) return;

  isRefreshing.value = true;
  // Simulate API call for filtering
  setTimeout(() => {
    appliedSelectedDate.value = currentSelectedDate.value;
    appliedSelectedCategories.value = [...selectedCategories.value];
    isRefreshing.value = false;
  }, 600);
};

// --- Article Interaction State ---
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

// --- Modal & Reader State ---
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

const closeReader = () => {
  showReaderModal.value = false;
  setTimeout(() => {
    document.body.style.overflow = "";
    activeArticleData.value = null;
  }, 300);
};

const openInBrowser = () => {
  alert("Opening in system default browser...");
  showPaywallModal.value = false;
};

// Computes the correct initial score to pass down to the slider
const activeRatingInitialScore = computed(() => {
  if (!activeRatingArticleId.value) return 0;
  const article = articles.value.find(a => a.id === activeRatingArticleId.value);
  return article ? article.score : 0;
});

// Opens the modal and closes the action menu on the card
const openRatingModal = (id: number) => {
  activeRatingArticleId.value = id;
  showRatingModal.value = true;
  activeActionMenu.value = null; // Close the 3-dot dropdown
};

// Receives the payload from the RatingModal and updates the specific article
const handleConfirmRating = (newScore: number) => {
  const articleIndex = articles.value.findIndex(a => a.id === activeRatingArticleId.value);
  
  if (articleIndex !== -1) {
    // 1. Extract the specific article into a variable
    const targetArticle = articles.value[articleIndex];
    
    // 2. Explicitly check if it exists to satisfy TypeScript
    if (targetArticle) {
      // 3. Mutate the property
      targetArticle.score = newScore;
    }
  }
};

// Ez a blokk automatikusan kezeli a görgetést
watch([showPaywallModal, showReaderModal, showRatingModal], ([newPaywall, newReader, newRating]) => {
  if (newPaywall || newReader || newRating) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
});
</script>

<style scoped>
/* Hide scrollbar for category dropdown */
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
