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
                @update="updateCategory"
                @deactivate="deactivateCategory"
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
                >{{ availableCategories.length - activeCategories.length }}/{{ availableCategories.length }}</span
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

      <div class="h-20"></div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
definePageMeta({ layout: "app-layout" });

const isActiveSectionOpen = ref(true);
const isInactiveSectionOpen = ref(true);

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
  {
    id: "ai_strategy",
    name: "Technology",
    weight: 85,
    icon: "memory",
    color: "#00E5FF",
    prompt:
      "Focus exclusively on architectural advancements, LLM scaling laws, and decentralized infrastructure.",
    chips: ["LLMs", "Rust", "Web3"],
  },
  {
    id: "market_analysis",
    name: "Economy",
    weight: 60,
    icon: "monitoring",
    color: "#fec931",
    prompt:
      "Filter out clickbait. Prioritize institutional reports, macro trends, and deep quantitative analysis.",
    chips: ["Macro", "Venture Capital"],
  },
  {
    id: "geopolitics",
    name: "Politics",
    weight: 45,
    icon: "public",
    color: "#FFFFFF",
    prompt:
      "Track EU tech regulations, AI governance acts, and global trade shifts affecting the semiconductor supply chain.",
    chips: ["EU Regs", "Supply Chain"],
  },
  {
    id: "science",
    name: "Science",
    weight: 30,
    icon: "science",
    color: "#00626e",
    prompt:
      "Focus on quantum computing breakthroughs and material sciences relevant to clean energy.",
    chips: ["Quantum", "Clean Energy"],
  },
]);

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
    weight: 0, // A DB-ben még 0 a súlya
    icon: cat.icon,
    color: cat.color,
    prompt: "",
    chips: [], // Üres AI node-ok
    isNew: true, // Ezzel kényszerítjük ki a sárga keretet és a gombot
  });
  
  // Automatikus odagörgetés a frissen hozzáadott kártyához
  setTimeout(() => {
    scrollToCard(newId);
  }, 150);
};

// Amikor rányom a "Save Changes"-re
// Amikor rányom a "Save Changes"-re
const updateCategory = (data: { id: string, weight: number, prompt: string }) => {
  // findIndex helyett find-ot használunk, ami visszaadja magát az objektumot
  const category = activeCategories.value.find(c => c.id === data.id);
  
  if (category) {
    category.weight = data.weight;
    category.prompt = data.prompt;
    category.isNew = false; // Sikeres mentés után normál állapotba kerül
  }
};

// Amikor rányom az X gombra az aktív kártyán
const deactivateCategory = (id: string) => {
  activeCategories.value = activeCategories.value.filter(c => c.id !== id);
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
</script>

<style scoped>
/* Optional: Additional smooth transition for the icon */
.rotate-180 {
  transform: rotate(180deg);
}
</style>
