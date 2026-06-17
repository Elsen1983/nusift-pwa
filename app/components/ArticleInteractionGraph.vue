<template>
  <div class="w-full flex flex-col items-center py-3">
    <div
      class="relative flex items-center justify-center min-h-[200px] w-full max-w-lg"
    >
      <transition name="slide-left">
        <div
          v-show="isExpanded"
          class="flex flex-col gap-4 absolute left-0 z-10 w-32"
        >
          <button
            @click="selectCategory('read')"
            :class="[
              'relative p-3 rounded-xl border text-left transition-all duration-100',
              selectedCategory === 'read'
                ? 'bg-primary-container/20 border-primary shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                : 'bg-[#00444c] border-primary-container hover:scale-110 animate-pulse-very-slow',
            ]"
          >
            <span
              class="block font-bold uppercase tracking-wider text-primary-container font-bold text-base leading-none"
              >Read</span
            >
            <span
              class="block text-xl font-headline font-bold text-on-surface"
              >{{ metrics.readArticles }}</span
            >
          </button>

          <button
            @click="selectCategory('shared')"
            :class="[
              'relative p-3 rounded-xl border text-left transition-all duration-100',
              selectedCategory === 'shared'
                ? 'bg-primary-container/20 border-primary shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                : 'bg-[#00444c] border-primary-container hover:scale-110 animate-pulse-very-slow',
            ]"
          >
            <span
              class="block font-bold uppercase tracking-wider text-primary-container font-bold text-base leading-none"
              >Shared</span
            >
            <span
              class="block text-xl font-headline font-bold text-on-surface"
              >{{ metrics.sharedArticles }}</span
            >
          </button>
        </div>
      </transition>

      <button
        @click="toggleExpand"
        :class="[
          'z-20 w-24 h-24 rounded-full border-2 flex flex-col items-center justify-center transition-all duration-500 ease-out shadow-lg',
          isExpanded
            ? 'bg-surface-container-highest border-primary scale-90'
            : 'bg-[#00444c] border-primary-container hover:scale-110 animate-pulse-slow',
        ]"
      >
        <span
          class="material-symbols-outlined text-primary mb-1 transition-transform duration-300"
          :class="{ 'rotate-45': isExpanded }"
        >
          {{ isExpanded ? "collapse_all" : "grid_view" }}
        </span>
        <span
          class="text-[12px] font-bold font-label uppercase tracking-widest"
          :class="isExpanded ? 'text-primary' : 'text-on-surface'"
        >
          Articles
        </span>
      </button>

      <transition name="slide-right">
        <div
          v-show="isExpanded"
          class="flex flex-col gap-4 absolute right-0 z-10 w-32"
        >
          <button
            @click="selectCategory('saved')"
            :class="[
              'relative p-3 rounded-xl border text-right transition-all duration-100',
              selectedCategory === 'saved'
                ? 'bg-primary-container/20 border-primary shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                : 'bg-[#00444c] border-primary-container hover:scale-110 animate-pulse-very-slow',
            ]"
          >
            <span
              class="block font-bold uppercase tracking-wider text-primary-container font-bold text-base leading-none"
              >Saved</span
            >
            <span
              class="block text-xl font-headline font-bold text-on-surface"
              >{{ metrics.savedArticles }}</span
            >
          </button>

          <button
            @click="selectCategory('rejected')"
            :class="[
              'relative p-3 rounded-xl border text-right transition-all duration-100',
              selectedCategory === 'rejected'
                ? 'bg-primary-container/20 border-primary shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                : 'bg-[#00444c] border-primary-container hover:scale-110 animate-pulse-very-slow',
            ]"
          >
            <span
              class="block font-bold uppercase tracking-wider text-primary-container font-bold text-base leading-none"
              >Rejected</span
            >
            <span
              class="block text-xl font-headline font-bold text-on-surface"
              >{{ metrics.rejectedArticles }}</span
            >
          </button>
        </div>
      </transition>
      <transition name="fade-up">
        <div
          v-if="isExpanded"
          class="absolute inset-0 flex items-center justify-center text-center bottom-[-190px]"
        >
          <p class="text-[12px] font-body text-on-surface-variant mt-1">
            Click any card to explore your personalized AI nodes.
          </p>
        </div>
      </transition>
    </div>
    <transition name="fade-up">
      <div
        v-if="selectedCategory"
        class="w-full p-2 mt-2 bg-surface-container-low border border-outline-variant/10 rounded-3xl shadow-lg"
      >
        <div class="flex items-center justify-between mb-1">
          <h4
            class="text-xs font-label font-bold text-on-surface-variant uppercase tracking-widest"
          >
            AI Nodes in <span class="text-primary-container">{{ selectedCategory }}</span> Articles
          </h4>
        </div>

        <div class="w-full mt-1">
          <AiNodeBarChart :nodes="currentAiNodes" />
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import AiNodeBarChart from "./AiNodeBarChart.vue";

const props = defineProps<{
  metrics: {
    readArticles: number;
    savedArticles: number;
    sharedArticles: number;
    rejectedArticles: number;
  };
}>();

const isExpanded = ref(false);
const selectedCategory = ref<string | null>(null);

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
  if (!isExpanded.value) {
    selectedCategory.value = null; // Close word cloud if graph is collapsed
  }
};

const selectCategory = (category: string) => {
  // Toggle off if clicking the same category, otherwise select new one
  selectedCategory.value =
    selectedCategory.value === category ? null : category;
};

// --- MOCK AI NODES ---
// Once you build the backend aggregation endpoint, you will replace these
// hardcoded arrays with real data fetched from your Prisma 'Article' table.
const mockNodes = {
  read: [
    { text: "Technology", value: 11 },
    { text: "AI", value: 18 },
    { text: "European Union", value: 5 },
    { text: "Cybersecurity", value: 8 },
    { text: "Startups", value: 9 },
    { text: "Vue.js", value: 3 },
  ],
  saved: [
    { text: "Web Development", value: 15 },
    { text: "Nuxt 4", value: 4 },
    { text: "PostgreSQL", value: 9 },
    { text: "Engineering", value: 2 },
  ],
  shared: [
    { text: "Tech Market", value: 8 },
    { text: "Ireland", value: 2 },
    { text: "Remote Work", value: 5 },
  ],
  rejected: [
    { text: "Celebrity Gossip", value: 12 },
    { text: "Sports", value: 5 },
    { text: "Clickbait", value: 3 },
    { text: "Astrology", value: 9 },
  ],
};

const currentAiNodes = computed(() => {
  if (!selectedCategory.value) return [];
  return mockNodes[selectedCategory.value as keyof typeof mockNodes] || [];
});
</script>

<style scoped>
/* Smooth outward expansion animations */
.slide-left-enter-active,
.slide-left-leave-active {
  transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.slide-left-enter-from,
.slide-left-leave-to {
  opacity: 0;
  transform: translateX(40px) scale(0.9);
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.slide-right-enter-from,
.slide-right-leave-to {
  opacity: 0;
  transform: translateX(-40px) scale(0.9);
}

.fade-up-enter-active,
.fade-up-leave-active {
  transition: all 0.4s ease-out;
}
.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* Optional gentle pulse for the central trigger when collapsed */
@keyframes pulse-slow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.1);
  }
  50% {
    box-shadow: 0 0 0 7px rgba(4, 143, 158, 0.329);
  }
}
@keyframes pulse-very-slow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.1);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(4, 143, 158, 0.329);
  }
}
.animate-pulse-slow {
  animation: pulse-slow 5s infinite;
}
.animate-pulse-very-slow {
  animation: pulse-very-slow 10s infinite;
}
</style>
