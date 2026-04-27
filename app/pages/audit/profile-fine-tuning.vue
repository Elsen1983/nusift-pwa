<template>
  <div class="relative min-h-screen">
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <main class="pt-5 pb-5 px-4 max-w-5xl mx-auto space-y-12 relative z-10">
      <section class="mb-12 px-2">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-4"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Profile Synthesis Audit</span
          >
        </div>
        <h2
          class="font-lg text-4xl md:text-5xl font-bold text-primary leading-tight tracking-tight mb-4 text-white"
        >
          Fine-Tune Your Intelligence
        </h2>
        <p
          class="text-on-surface-variant text-12 max-w-2xl leading-relaxed font-body"
        >
          Refine how your AI Agent prioritizes information. Adjust weights,
          provide specific technical instructions, and audit the curated
          sub-nodes.
        </p>
      </section>

      <section class="flex flex-col items-center justify-center py-2">
        <div class="relative w-48 h-48 md:w-80 md:h-80">
          <svg
            class="w-full h-full drop-shadow-[0_0_30px_rgba(0,229,255,0.1)]"
            viewBox="0 0 100 100"
          >
            <path
              v-for="slice in pieSlices"
              :key="slice.id"
              :d="slice.path"
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
            class="w-full flex items-center justify-between p-4 bg-surface-container-low/50"
          >
            <h2 class="font-headline text-2xl font-bold text-white">
              Active Horizon
            </h2>
            <span
              class="bg-surface-container-highest px-3 py-1 rounded-full text-xs font-label font-bold text-primary"
              >4 Active</span
            >
          </div>
          <div
            class="p-3 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-outline-variant/10"
          >
            <ActiveCategoryCard
  v-for="cat in mappedActiveCategories"
  :key="cat.id"
  v-bind="cat"
  @update="handleUpdate"
  :id="'card-' + cat.id"
/>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-outline-variant/10"
        >
          <div class="w-full flex items-center justify-between p-6">
            <h2 class="font-headline text-2xl font-bold text-white/50">
              Inactive Categories
            </h2>
            <span
              class="bg-surface-container-highest px-3 py-1 rounded-full text-xs font-label font-bold text-on-surface-variant"
              >14/18</span
            >
          </div>
          <div
            class="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-outline-variant/10"
          >
            <InactiveCategoryCard
              v-for="cat in inactiveCategories"
              :key="cat.id"
              v-bind="cat"
            />
          </div>
        </div>
      </section>

      <section class="flex flex-col items-center py-12">
        <div
          class="w-full max-w-md border-2 border-error/40 rounded-3xl p-8 space-y-6 relative bg-error/5"
        >
          <div
            class="absolute -top-3 left-1/2 -translate-x-1/2 bg-surface px-4 text-error font-label text-[10px] uppercase tracking-[0.2em] font-bold"
          >
            System Danger Zone
          </div>
          <div class="space-y-4">
            <button
              class="w-full py-4 px-6 rounded-2xl border border-outline-variant hover:bg-surface-container-highest transition-all flex items-center justify-between group text-on-surface"
            >
              <div class="flex items-center gap-3">
                <span
                  class="material-symbols-outlined group-hover:text-primary transition-colors"
                  >cloud_download</span
                >
                <span class="font-headline font-bold"
                  >Export Interest Graph</span
                >
              </div>
              <span class="material-symbols-outlined opacity-30 text-sm"
                >chevron_right</span
              >
            </button>
            <button
              class="w-full py-4 px-6 rounded-2xl border border-error/40 hover:bg-error/10 transition-all flex items-center justify-between group text-error"
            >
              <div class="flex items-center gap-3">
                <span class="material-symbols-outlined">delete_sweep</span>
                <span class="font-headline font-bold">Reset Agent Memory</span>
              </div>
              <span class="material-symbols-outlined opacity-30 text-sm"
                >chevron_right</span
              >
            </button>
          </div>
        </div>
      </section>
    </main>

    <div
      class="fixed bottom-[85px] left-0 w-full z-[80] p-6 flex justify-center pointer-events-none"
    >
      <button
        class="w-full max-w-lg pointer-events-auto bg-gradient-to-r from-[#00daf3] to-[#00626e] text-on-primary font-headline font-bold py-4 rounded-full shadow-[0_8px_32px_rgba(0,229,255,0.3)] active:scale-95 transition-all flex items-center justify-center gap-2"
      >
        <span class="material-symbols-outlined">save</span> SAVE ALL CHANGES
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
definePageMeta({ layout: "app-layout" });

const availableCategories = [
  { name: "Politics", icon: "policy", color: "#FFFFFF" },
  { name: "Economy", icon: "payments", color: "#fec931" },
  { name: "Technology", icon: "memory", color: "#00E5FF" },
  { name: "Science", icon: "science", color: "#00626e" },
  { name: "Health", icon: "health_and_safety", color: "#ffb4ab" },
  { name: "Environment", icon: "eco", color: "#81c784" },
  { name: "Entertainment", icon: "movie", color: "#ba68c8" },
  { name: "Culture", icon: "museum", color: "#ff8a65" },
  { name: "Sports", icon: "sports_soccer", color: "#ffd54f" },
  { name: "Society", icon: "public", color: "#4fc3f7" },
  { name: "Transport", icon: "directions_car", color: "#90a4ae" },
  { name: "Lifestyle", icon: "style", color: "#f06292" },
  { name: "Gastronomy", icon: "restaurant", color: "#a1887f" },
  { name: "Real Estate", icon: "home", color: "#d4e157" },
  { name: "Gardening", icon: "yard", color: "#4db6ac" },
  { name: "Travel", icon: "flight", color: "#4f91ff" },
  { name: "Hobbies", icon: "sports_esports", color: "#9575cd" },
  { name: "Education", icon: "school", color: "#fff176" },
];

// Active State
const activeCategories = ref([
  {
    id: "tech",
    name: "Technology",
    icon: "memory",
    weight: 65,
    prompt: "Focus on GenAI.",
    chips: ["LLMs", "GPU"],
    color: "#00E5FF",
  },
  {
    id: "politics",
    name: "Politics",
    icon: "policy",
    weight: 40,
    prompt: "Regulation focus.",
    chips: ["EU Acts"],
    color: "#FFFFFF",
  },
  {
    id: "science",
    name: "Science",
    icon: "science",
    weight: 76,
    prompt: "Spaceship focus.",
    chips: ["SpaceX", "NASA"],
    color: "#00626e",
  },
]);

// 1. FIX: Derive inactiveCategories from available minus active
const inactiveCategories = computed(() => {
  return availableCategories.filter(
    (avail) => !activeCategories.value.some((active) => active.name === avail.name)
  ).map(cat => ({
    // Mapping for InactiveCategoryCard
    id: cat.name.toLowerCase().replace(/\s+/g, '-'),
    title: cat.name,
    icon: cat.icon
  }));
});

// 2. FIX: Computed property to map data to Component Props
const mappedActiveCategories = computed(() => {
  return activeCategories.value.map(cat => ({
    id: cat.id,
    title: cat.name,           // Maps 'name' to 'title'
    icon: cat.icon,
    initialWeight: cat.weight, // Maps 'weight' to 'initialWeight'
    initialPrompt: cat.prompt, // Maps 'prompt' to 'initialPrompt'
    chips: cat.chips,
    themeColor: cat.color
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
  return `M 50 50 L ${x1} ${y1} A 45 45 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
}

const scrollToCard = (id: string) => {
  const el = document.getElementById(`card-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary");
    setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 2000);
  }
};

const handleUpdate = (payload: any) => {
  console.log("Update received:", payload);
};
</script>

<style scoped></style>