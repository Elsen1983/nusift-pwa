<template>
  <div
    class="bg-surface text-on-surface font-body selection:bg-primary-container selection:text-on-primary-container min-h-screen relative z-0"
  >
    <div
      class="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    
    <div
      class="fixed bottom-0 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-secondary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <header class="fixed top-0 left-0 w-full z-50 bg-[#131313]">
      <div
        class="mx-auto w-full max-w-4xl flex items-center justify-between px-6 py-4"
      >
        <div
          class="flex items-center gap-3 cursor-pointer group"
          @click="router.replace('/source-calibration')"
        >
          <span
            class="material-symbols-outlined text-[#00E5FF] group-hover:-translate-x-1 transition-transform"
            >arrow_back</span
          >
          <h1
            class="font-headline tracking-tighter text-[#00E5FF] group-hover:text-white transition-colors"
          >
            Back to Source Calibration
          </h1>
        </div>
        <div class="hidden md:flex flex-col items-end">
          <span
            class="text-[10px] text-on-surface-variant font-label uppercase tracking-[0.2em]"
            >Step 03/03</span
          >
          <div
            class="w-32 h-1 bg-surface-container-highest rounded-full mt-1 overflow-hidden"
          >
            <div
              class="h-full w-[100%] bg-primary-container shadow-[0_0_8px_rgba(0,229,255,0.5)]"
            ></div>
          </div>
        </div>
      </div>
    </header>

    <main class="mt-12 pt-6 pb-2 px-6 max-w-4xl mx-auto flex flex-col">
      <section class="mb-4 px-2">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-4"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Interest Selection Phase</span
          >
        </div>
        <h1
          class="font-headline text-3xl md:text-4xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          Map Your Horizon
        </h1>
        <p class="text-on-surface-variant text-[14px] leading-relaxed">
          Select the thematic pillars of your intelligence feed. You can
          fine-tune these later in your Profile Audit.
        </p>
        <div class="flex items-center justify-between pt-4">
          <h3
            class="font-headline text-medium md:text-xl text-primary font-medium"
          >
            Categories
          </h3>
          <span class="text-on-surface-variant font-label text-[12px]">
            {{ selected.length }}/20 Selected
          </span>
        </div>
      </section>

      <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
        <button
          v-for="cat in availableCategories"
          :key="cat.name"
          @click="toggleCategory(cat.name)"
          :disabled="isInitializing"
          :class="[
            'group flex items-center p-2 rounded-lg transition-all duration-200',
            !isInitializing
              ? 'active:scale-[0.98]'
              : 'opacity-60 cursor-not-allowed',
            selected.includes(cat.name)
              ? 'border border-primary-container bg-surface-container shadow-[0_0_15px_rgba(0,229,255,0.2)]'
              : 'bg-surface-container-low hover:bg-surface-container',
          ]"
        >
          <div
            :class="[
              'mr-3',
              selected.includes(cat.name)
                ? 'text-primary-container'
                : 'text-primary-fixed-dim',
            ]"
          >
            <span
              class="material-symbols-outlined text-xl"
              :style="{
                fontVariationSettings: selected.includes(cat.name)
                  ? '&quot;FILL&quot; 1'
                  : '&quot;FILL&quot; 0',
              }"
            >
              {{ cat.icon }}
            </span>
          </div>
          <div class="text-left overflow-hidden flex-1">
            <div class="flex items-center justify-between gap-1">
              <h3
                :class="[
                  'font-headline text-[12px] font-semibold truncate',
                  selected.includes(cat.name)
                    ? 'text-primary'
                    : 'text-on-surface',
                ]"
              >
                {{ cat.name }}
              </h3>
              <span
                v-if="selected.includes(cat.name)"
                class="material-symbols-outlined text-primary text-[14px]"
                >check_circle</span
              >
            </div>
          </div>
        </button>
      </div>

      <section class="flex flex-col items-end mb-4">
        <button
          @click="finalizeOnboarding"
          :disabled="selected.length === 0 || isInitializing"
          class="flex items-center gap-3 px-6 py-2 rounded-xl transition-all group bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed"
        >
          <span class="font-headline font-bold">
            {{ isInitializing ? "Finalizing..." : "Next: Build My Feed" }}
          </span>

          <span
            class="material-symbols-outlined transition-transform"
            :class="{
              'animate-spin': isInitializing,
              'group-hover:translate-x-1': !isInitializing,
            }"
          >
            {{ isInitializing ? "sync" : "arrow_forward" }}
          </span>
          <!-- <span
            v-if="!isInitializing"
            class="material-symbols-outlined font-bold"
            >bolt</span
          >
          <span v-else class="material-symbols-outlined animate-spin"
            >progress_activity</span
          > -->
        </button>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";

const router = useRouter();
const authStore = useAuthStore();
const agentStore = useAgentStore();
const isInitializing = ref(false);
const selected = ref<string[]>([]);

const availableCategories = [
  { name: "Politics", icon: "policy" },
  { name: "Economy", icon: "payments" },
  { name: "Technology", icon: "memory" },
  { name: "Science", icon: "science" },
  { name: "Health", icon: "health_and_safety" },
  { name: "Environment", icon: "eco" },
  { name: "Entertainment", icon: "movie" },
  { name: "Culture", icon: "museum" },
  { name: "Sports", icon: "sports_soccer" },
  { name: "Society", icon: "public" },
  { name: "Transport", icon: "directions_car" },
  { name: "Lifestyle", icon: "style" },
  { name: "Gastronomy", icon: "restaurant" },
  { name: "Real Estate", icon: "home" },
  { name: "Gardening", icon: "yard" },
  { name: "Travel", icon: "flight" },
  { name: "Hobbies", icon: "sports_esports" },
  { name: "Education", icon: "school" },
];

const toggleCategory = (name: string) => {
  if (isInitializing.value) return; // Prevent changes while initializing
  const idx = selected.value.indexOf(name); // Toggle selection
  if (idx === -1)
    selected.value.push(name); // Add if not selected, remove if selected
  else selected.value.splice(idx, 1);
};

const finalizeOnboarding = async () => {
  if (selected.value.length === 0 || isInitializing.value) return;

  isInitializing.value = true;

  try {
    // 1. Structure the selected strings into the new JSON format
    const structuredInterests = selected.value.map((name) => ({
      id: name.toLowerCase().replace(/\s+/g, "_"),
      name: name,
      weight: 100, // Default to 100% on first calibration
      prompt: "", // Empty prompt
      chips: [], // Empty nodes
    }));

    // 2. Update Pinia
    agentStore.topInterests = structuredInterests;

    // 3. Backend Save
    await $fetch("/api/user/finalize-onboarding", {
      method: "POST",
      body: {
        region: agentStore.primaryRegion,
        sources: agentStore.topSources,
        interests: structuredInterests,
      },
    });

    if (authStore.user) {
      authStore.user.onboardingStep = 3;
      authStore.user.topInterests = structuredInterests; // NEW: Sync state

      if (!import.meta.server) {
        localStorage.setItem(
          "nusift_pwa_profile",
          JSON.stringify(authStore.user),
        );
      }
    }

    setTimeout(() => {
      router.replace("/initialization-preloader-page");
    }, 2000);
  } catch (error) {
    console.error("Hiba az onboarding véglegesítése során:", error);
    isInitializing.value = false;
  }
};
</script>
