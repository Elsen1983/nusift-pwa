<template>
  <div
    class="bg-background text-on-background font-body min-h-screen relative z-0"
  >
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    <div
      class="fixed bottom-0 left-0 w-[500px] h-[500px] bg-secondary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <header
      class="fixed top-0 w-full z-50 bg-[#131313] flex items-center justify-between px-6 py-4"
    >
      <div class="flex items-center gap-3">
        <button
          @click="router.replace('/source-calibration')"
          class="hover:bg-[#353534] transition-colors p-2 rounded-full active:scale-95 duration-200 flex items-center justify-center"
        >
          <span class="material-symbols-outlined text-[#00E5FF]"
            >arrow_back</span
          >
        </button>
        <div
          class="text-[#00E5FF] font-headline font-medium tracking-widest text-[10px] uppercase opacity-70"
        >
          Back to source calibration
        </div>
      </div>
      <div class="w-10"></div>
    </header>

    <main class="pt-24 px-4 max-w-5xl mx-auto pb-12">
      <section class="mb-12 px-2">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-4"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Interest Selection Phase</span
          >
        </div>
        <h1
          class="font-headline text-4xl md:text-5xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          Map Your Horizon
        </h1>
        <p
          class="font-body text-on-surface-variant text-lg max-w-2xl leading-relaxed"
        >
          Select the thematic pillars of your intelligence feed. You can
          fine-tune these later in your Profile Audit.
        </p>
      </section>

      <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-12">
        <button
          v-for="cat in availableCategories"
          :key="cat.name"
          @click="toggleCategory(cat.name)"
          :disabled="isInitializing"
          :class="[
            'group flex items-center p-3 rounded-lg transition-all duration-200',
            !isInitializing ? 'active:scale-[0.98]' : 'opacity-60 cursor-not-allowed',
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
                  'font-headline text-sm font-semibold truncate',
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

      <div class="flex flex-col items-center gap-6 pb-20">
        <button
          @click="finalizeOnboarding"
          :disabled="selected.length === 0 || isInitializing"
          class="group relative w-full md:w-auto px-10 py-4 rounded-full bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-headline font-bold text-lg tracking-tight shadow-[0_8px_32px_rgba(0,229,255,0.3)] transition-all hover:shadow-[0_12px_48px_rgba(0,229,255,0.4)] active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Initialize My Sovereign Feed
          <span
            v-if="!isInitializing"
            class="material-symbols-outlined font-bold"
            >bolt</span
          >
          <span v-else class="material-symbols-outlined animate-spin"
            >progress_activity</span
          >
        </button>
        <p
          class="font-label text-on-surface-variant text-[10px] uppercase tracking-[0.2em] opacity-60"
        >
          {{ selected.length }}/20 Pillars Selected
        </p>
      </div>
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
  if (idx === -1) selected.value.push(name); // Add if not selected, remove if selected
  else selected.value.splice(idx, 1);
};

const finalizeOnboarding = async () => {
  if (selected.value.length === 0 || isInitializing.value) return;
  
  isInitializing.value = true;

  try {
    // 1. Structure the selected strings into the new JSON format
    const structuredInterests = selected.value.map(name => ({
      id: name.toLowerCase().replace(/\s+/g, "_"),
      name: name,
      weight: 100, // Default to 100% on first calibration
      prompt: "",  // Empty prompt
      chips: []    // Empty nodes
    }));

    // 2. Update Pinia
    agentStore.topInterests = structuredInterests;

    // 3. Backend Save
    await $fetch("/api/user/finalize-onboarding", {
      method: "POST",
      body: {
        region: agentStore.primaryRegion,
        sources: agentStore.topSources,
        interests: structuredInterests
      }
    });

    if (authStore.user) {
      authStore.user.onboardingStep = 3; 

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
