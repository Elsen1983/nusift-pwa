<template>
  <div class="relative min-h-screen">
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <main class="pt-5 pb-5 px-4 max-w-5xl mx-auto space-y-4 relative z-10">
      <section class="mb-4 px-2">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-2"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Profile Synthesis Audit</span
          >
        </div>
        <h2
          class="font-lg text-3xl md:text-5xl font-bold text-primary leading-tight tracking-tight mb-4 text-white"
        >
          Fine-Tune Your Intelligence
        </h2>
        <p
          class="text-on-surface-variant text-[12px] max-w-2xl leading-relaxed font-body"
        >
          Refine how your AI Agent prioritizes information. Adjust weights,
          provide specific technical instructions, and audit the curated
          sub-nodes.
        </p>
      </section>

      <section class="flex flex-col items-center justify-center py-0">
        <div class="relative w-64 h-64 md:w-80 md:h-80">
          <svg viewBox="0 0 100 100" class="w-full h-full transform -rotate-90">
            <path
              v-for="(slice, index) in pieSlices"
              :key="'pie-' + slice.id"
              :d="`M 50 50 L ${slice.path.x1} ${slice.path.y1} A 45 45 0 ${slice.path.largeArcFlag} 1 ${slice.path.x2} ${slice.path.y2} Z`"
              :fill="slice.color"
              stroke="#131313"
              stroke-width="0.5"
              class="cursor-pointer hover:opacity-80 transition-opacity"
              @click="scrollToCard(slice.id)"
            />
          </svg>
        </div>

        <div class="mt-4 flex flex-wrap justify-center gap-4 max-w-2xl px-4">
          <div
            v-for="cat in activeCategories"
            :key="cat.id"
            @click="scrollToCard(cat.id)"
            class="flex items-center gap-2 cursor-pointer hover:scale-105 transition-transform"
          >
            <div
              class="w-2.5 h-2.5 rounded-full"
              :style="{ backgroundColor: cat.color }"
            ></div>
            <span
              class="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant"
            >
              {{ cat.name }}
            </span>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-outline-variant/10"
        >
          <div
            @click="isActiveSectionOpen = !isActiveSectionOpen"
            class="w-full flex items-center justify-between p-4 bg-surface-container-low/50 cursor-pointer hover:bg-surface-container-low/80 transition-colors select-none"
          >
            <h2 class="font-headline text-[16px] font-bold text-white">
              Active Horizon
            </h2>
            <div class="flex items-center gap-3">
              <span
                class="bg-surface-container-highest px-3 py-1 rounded-full text-[12px] font-label font-bold text-primary"
                >{{ activeCategories.length }} Active</span
              >
              <span
                class="material-symbols-outlined text-on-surface-variant transition-transform duration-300"
                :class="{ 'rotate-180': isActiveSectionOpen }"
              >
                expand_more
              </span>
            </div>
          </div>
          <div
            v-show="isActiveSectionOpen"
            class="p-3 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-outline-variant/10"
          >
            <div
              v-for="cat in mappedActive"
              :key="cat.id"
              :id="`card-${cat.id}`"
              class="rounded-3xl transition-all duration-300"
            >
              <ActiveCategoryCard
                :id="cat.id"
                :title="cat.name"
                :icon="cat.icon"
                :initial-weight="cat.weight"
                :initial-prompt="cat.initialPrompt"
                :chips="cat.chips"
                :theme-color="cat.themeColor"
                :is-new="cat.isNew"
                :global-save-tick="globalSaveTick"
                @update="updateCategory"
                @deactivate="deactivateCategory"
                @scroll-to-global="scrollToGlobalButton"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-outline-variant/10"
        >
          <div
            @click="isInactiveSectionOpen = !isInactiveSectionOpen"
            class="w-full flex items-center justify-between p-4 cursor-pointer hover:bg-surface-container-low/50 transition-colors select-none"
          >
            <h2 class="font-headline text-[16px] font-bold text-white">
              Inactive Categories
            </h2>
            <div class="flex items-center gap-3">
              <span
                class="bg-surface-container-highest px-3 py-1 rounded-full text-[12px] font-label font-bold text-white"
                >{{ availableCategories.length - activeCategories.length }}/{{
                  availableCategories.length
                }}</span
              >
              <span
                class="material-symbols-outlined text-on-surface-variant transition-transform duration-300"
                :class="{ 'rotate-180': isInactiveSectionOpen }"
              >
                expand_more
              </span>
            </div>
          </div>
          <div
            v-show="isInactiveSectionOpen"
            class="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-outline-variant/10"
          >
            <InactiveCategoryCard
              v-for="cat in availableCategories.filter(
                (c) => !activeCategories.find((ac) => ac.name === c.name),
              )"
              :key="cat.name"
              :id="cat.name.toLowerCase().replace(/\s+/g, '_')"
              :title="cat.name"
              :icon="cat.icon"
              :theme-color="cat.color"
              @add="addCategory(cat)"
            />
          </div>
        </div>
      </section>
      <!-- System Danger Zone (Szín-korrigált verzió) -->
      <section class="flex flex-col items-center py-12">
        <!-- A konténer: Sötét, meleg árnyalat, diszkrét lazac keret -->
        <div class="w-full max-w-md border border-error/20 rounded-2xl p-8 space-y-6 relative bg-[#181515]">
          <!-- A fejléc: Sötét háttéren vágja el a keretet -->
          <div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#181515] px-4 text-[#ffb4ab] font-label text-[10px] uppercase tracking-[0.2em] whitespace-nowrap">
            System Danger Zone
          </div>
          
          <div class="grid grid-cols-1 gap-4">
            <!-- 1. Gomb: Export (Semleges szürke) -->
            <button class="w-full py-4 px-6 rounded-xl border border-outline-variant/30 bg-[#1e1e1e] hover:bg-surface-container-highest transition-all flex items-center justify-between group">
              <div class="flex items-center gap-4">
                <span class="material-symbols-outlined text-[#c0c8ca] text-xl transition-colors">cloud_download</span>
                <span class="font-headline text-sm font-semibold text-[#e5e2e1]">Export Interest Graph</span>
              </div>
              <span class="material-symbols-outlined text-on-surface-variant/30 text-sm">chevron_right</span>
            </button>
            
            <!-- 2. Gomb: Reset (Lazac / Error szín) -->
            <button class="w-full py-4 px-6 rounded-xl border border-error/30 bg-[#1e1e1e] hover:bg-error/10 transition-all flex items-center justify-between group">
              <div class="flex items-center gap-4">
                <span class="material-symbols-outlined text-[#ffb4ab] text-xl">delete_sweep</span>
                <span class="font-headline text-sm font-semibold text-[#ffb4ab]">Reset Agent Memory</span>
              </div>
              <span class="material-symbols-outlined text-error/40 text-sm">chevron_right</span>
            </button>
          </div>
        </div>
      </section>
      <section class="flex justify-center w-full pt-8 pb-12 px-4">
        <button 
          id="global-save-btn"
          @click="saveAllChanges"
          :disabled="!globalHasChanges || isSavingGlobal"
          class="w-full max-w-lg bg-gradient-to-r from-[#00daf3] to-[#00626e] text-on-primary font-headline font-bold py-4 rounded-full shadow-[0_8px_32px_rgba(0,229,255,0.2)] hover:shadow-[0_12px_40px_rgba(0,229,255,0.3)] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed"
        >
          <span v-if="!isSavingGlobal" class="material-symbols-outlined">save</span>
          <span v-else class="material-symbols-outlined animate-spin">progress_activity</span>
          {{ isSavingGlobal ? 'SAVING CHANGES...' : 'SAVE ALL CHANGES' }}
        </button>
      </section>
      <div class="h-10"></div>
      
    </main>
    
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { useAgentStore } from "~/stores/agent";
definePageMeta({ layout: "app-layout" });

const agentStore = useAgentStore();
const globalHasChanges = ref(false); // Tracks if there are unsaved changes globally
const isSavingGlobal = ref(false);   // Tracks API call state
const isActiveSectionOpen = ref(true);
const isInactiveSectionOpen = ref(true);
// NEW: Tick system to broadcast successful saves to all cards
const globalSaveTick = ref(0);

const availableCategories = [
  { name: "Politics", icon: "policy", color: "#FFFFFF" },
  { name: "Economy", icon: "payments", color: "#fec931" },
  { name: "Technology", icon: "memory", color: "#00E5FF" },
  { name: "Science", icon: "science", color: "#00626e" },
  { name: "Health", icon: "health_and_safety", color: "#ffb4ab" },
  { name: "Environment", icon: "eco", color: "#81c784" },
  { name: "Business", icon: "business_center", color: "#FFD54F" },
  { name: "Art & Culture", icon: "palette", color: "#E1BEE7" },
  { name: "Sports", icon: "sports_soccer", color: "#FFCC80" },
  { name: "Entertainment", icon: "movie", color: "#F48FB1" },
  { name: "Travel", icon: "flight", color: "#80CBC4" },
  { name: "Food & Drink", icon: "restaurant", color: "#FFAB91" },
  { name: "Lifestyle", icon: "self_improvement", color: "#BCAAA4" },
  { name: "Gaming", icon: "sports_esports", color: "#9FA8DA" },
  { name: "Automotive", icon: "directions_car", color: "#B0BEC5" },
  { name: "Real Estate", icon: "house", color: "#A5D6A7" },
  { name: "Law & Crime", icon: "gavel", color: "#CE93D8" },
  { name: "Education", icon: "school", color: "#90CAF9" },
];

interface ActiveCategory {
  id: string;
  name: string;
  weight: number;
  icon: string;
  color: string;
  prompt: string;
  chips: string[];
  isNew?: boolean; // AZ OPCIONÁLIS MEZŐ, ami miatt nem lesz több hiba!
}

const activeCategories = ref<ActiveCategory[]>([
  // {
  //   id: "ai_strategy",
  //   name: "Technology",
  //   weight: 85,
  //   icon: "memory",
  //   color: "#00E5FF",
  //   prompt:
  //     "Focus exclusively on architectural advancements, LLM scaling laws, and decentralized infrastructure.",
  //   chips: ["LLMs", "Rust", "Web3"],
  // },
  // {
  //   id: "market_analysis",
  //   name: "Economy",
  //   weight: 60,
  //   icon: "monitoring",
  //   color: "#fec931",
  //   prompt:
  //     "Filter out clickbait. Prioritize institutional reports, macro trends, and deep quantitative analysis.",
  //   chips: ["Macro", "Venture Capital"],
  // },
  // {
  //   id: "geopolitics",
  //   name: "Politics",
  //   weight: 45,
  //   icon: "public",
  //   color: "#FFFFFF",
  //   prompt:
  //     "Track EU tech regulations, AI governance acts, and global trade shifts affecting the semiconductor supply chain.",
  //   chips: ["EU Regs", "Supply Chain"],
  // },
  // {
  //   id: "science",
  //   name: "Science",
  //   weight: 30,
  //   icon: "science",
  //   color: "#00626e",
  //   prompt:
  //     "Focus on quantum computing breakthroughs and material sciences relevant to clean energy.",
  //   chips: ["Quantum", "Clean Energy"],
  // },
]);

// Hydrate from Pinia on mount
onMounted(() => {
  if (agentStore.topInterests && agentStore.topInterests.length > 0) {
    activeCategories.value = agentStore.topInterests.map((interest) => {
      // Find matching visual data
      const matchingCat = availableCategories.find(c => c.name === interest.name);
      return {
        ...interest,
        icon: matchingCat?.icon || "category",
        color: matchingCat?.color || "#FFFFFF",
        isNew: false
      };
    });
  }
});

// Map internal active categories to match ActiveCategoryCard props
const mappedActive = computed(() => {
  return activeCategories.value.map((cat: any) => ({
    ...cat,
    initialPrompt: cat.prompt,
    chips: cat.chips,
    themeColor: cat.color,
    isNew: cat.isNew,
  }));
});

// Pie Chart (Equal Distribution)
const pieSlices = computed(() => {
  const total = activeCategories.value.length;
  if (total === 0) return [];
  const sliceAngle = 360 / total;
  let currentAngle = 0;
  return activeCategories.value.map((cat) => {
    const startAngle = currentAngle;
    currentAngle += sliceAngle;
    return {
      ...cat,
      path: getCoordinatesForAngle(startAngle, currentAngle),
    };
  });
});

function getCoordinatesForAngle(startAngle: number, endAngle: number) {
  const x1 = 50 + 45 * Math.cos(((startAngle - 90) * Math.PI) / 180);
  const y1 = 50 + 45 * Math.sin(((startAngle - 90) * Math.PI) / 180);
  const x2 = 50 + 45 * Math.cos(((endAngle - 90) * Math.PI) / 180);
  const y2 = 50 + 45 * Math.sin(((endAngle - 90) * Math.PI) / 180);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return { x1, y1, x2, y2, largeArcFlag };
}

const addCategory = (cat: any) => {
  const newId = cat.name.toLowerCase().replace(/\s+/g, "_");
  activeCategories.value.push({
    id: newId,
    name: cat.name,
    weight: 100,
    icon: cat.icon,
    color: cat.color,
    prompt: "",
    chips: [],
    isNew: true,
  });
  
  globalHasChanges.value = true; // Flag change

  setTimeout(() => {
    scrollToCard(newId);
  }, 150);
};

// const updateCategory = async (data: { id: string; weight: number; prompt: string; }) => {
//   const category = activeCategories.value.find((c) => c.id === data.id);

//   if (category) {
//     category.weight = data.weight;
//     category.prompt = data.prompt;
//     category.isNew = false; 
    
//     // Mark that we have global changes ready to be saved to the DB
//     globalHasChanges.value = true;

//     // Wait for the DOM to update (button becomes active), then scroll to it
//     await nextTick();
//     const globalSaveBtn = document.getElementById("global-save-btn");
    
//     if (globalSaveBtn) {
//       globalSaveBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      
//       // Optional: Add a brief highlight effect to draw the user's attention
//       globalSaveBtn.classList.add("ring-4", "ring-[#00E5FF]", "ring-offset-4", "ring-offset-[#131313]");
//       setTimeout(() => {
//         globalSaveBtn.classList.remove("ring-4", "ring-[#00E5FF]", "ring-offset-4", "ring-offset-[#131313]");
//       }, 1500);
//     }
//   }
// };

const updateCategory = (data: { id: string; weight: number; prompt: string; }) => {
  const category = activeCategories.value.find((c) => c.id === data.id);
  if (category) {
    category.weight = data.weight;
    category.prompt = data.prompt;
    globalHasChanges.value = true;
  }
};

// NEW: Handing the scroll event
const scrollToGlobalButton = async () => {
  await nextTick();
  const globalSaveBtn = document.getElementById("global-save-btn");
  if (globalSaveBtn) {
    globalSaveBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    globalSaveBtn.classList.add("ring-4", "ring-[#00E5FF]", "ring-offset-4", "ring-offset-[#131313]");
    setTimeout(() => {
      globalSaveBtn.classList.remove("ring-4", "ring-[#00E5FF]", "ring-offset-4", "ring-offset-[#131313]");
    }, 1500);
  }
};

// Amikor rányom az X gombra az aktív kártyán
const deactivateCategory = (id: string) => {
  activeCategories.value = activeCategories.value.filter((c) => c.id !== id);
  globalHasChanges.value = true; // Flag change
};

const scrollToCard = async (id: string) => {
  // 1. Biztosítjuk, hogy a szekció nyitva legyen a görgetés előtt
  if (!isActiveSectionOpen.value) {
    isActiveSectionOpen.value = true;
  }

  // 2. Megvárjuk, amíg a Vue frissíti a DOM-ot (ha ki kellett nyitni)
  await nextTick();

  // 3. Most már garantáltan létezik az elem a DOM-ban
  const element = document.getElementById(`card-${id}`);
  console.log("Scrolling to:", id, element);

  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });

    // Vizuális visszajelzés
    element.classList.add(
      "ring-2",
      "ring-primary",
      "ring-offset-4",
      "ring-offset-background",
    );

    setTimeout(() => {
      element.classList.remove(
        "ring-2",
        "ring-primary",
        "ring-offset-4",
        "ring-offset-background",
      );
    }, 1500);
  }
};

// --- NEW FUNCTION: The Global API Call ---
const saveAllChanges = async () => {
  if (!globalHasChanges.value || isSavingGlobal.value) return;
  isSavingGlobal.value = true;

  try {
    const structuredInterests = activeCategories.value.map(cat => ({
      id: cat.id,
      name: cat.name,
      weight: cat.weight,
      prompt: cat.prompt,
      chips: cat.chips
    }));

    agentStore.topInterests = structuredInterests;

    await $fetch("/api/user/update-interests", {
      method: "POST",
      body: { interests: structuredInterests }
    });

    globalHasChanges.value = false;
    
    // NEW: Broadcast to all cards that the save was successful so they can turn neutral
    globalSaveTick.value++; 

    // NEW: Scroll automatically to the top after success
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });

  } catch (error) {
    console.error("Failed to save global changes:", error);
  } finally {
    isSavingGlobal.value = false;
  }
};
</script>

<style scoped>
/* Optional: Additional smooth transition for the icon */
.rotate-180 {
  transform: rotate(180deg);
}
</style>
