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
          @click="goBackToSource"
        >
          <span
            class="material-symbols-outlined text-[#00E5FF] group-hover:-translate-x-1 transition-transform"
            >arrow_back</span
          >
          <h1
            class="font-headline tracking-tighter text-[#00E5FF] group-hover:text-white transition-colors"
          >
            {{ $t("interestCalibration.back_link") }}
          </h1>
        </div>
        <div class="hidden md:flex flex-col items-end">
          <span
            class="text-[10px] text-on-surface-variant font-label uppercase tracking-[0.2em]"
            >{{ $t("interestCalibration.step_indicator") }}</span
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
            >{{ $t("interestCalibration.badge_selection") }}</span
          >
        </div>
        <h1
          class="font-headline text-3xl md:text-4xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          {{ $t("interestCalibration.title") }}
        </h1>
        <p class="text-on-surface-variant text-[14px] leading-relaxed">
          {{ $t("interestCalibration.description") }}
        </p>
        <div class="flex items-center justify-between pt-4">
          <h3
            class="font-headline text-medium md:text-xl text-primary font-medium"
          >
            {{ $t("interestCalibration.categories_title") }}
          </h3>
          <span class="text-on-surface-variant font-label text-[12px]">
            {{ selected.length }}/20 {{ $t("interestCalibration.selected_count") }}
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
                {{ $t('interestCalibration.categories.' + cat.i18nKey) }}
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
          <span class="font-headline text-[15px] font-bold">
            {{ isInitializing ? $t('interestCalibration.btn_finalizing') : $t('interestCalibration.btn_next') }}
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
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import { $api } from "~/utils/api";

const navigate = useSovereignNavigate();
const authStore = useAuthStore();
const agentStore = useAgentStore();
const isInitializing = ref(false);
const selected = ref<string[]>([]);

const goBackToSource = async () => {
  if (isInitializing.value) return;

  // Downgrade the onboarding step to 1 (Source Calibration)
  if (authStore.user) {
    authStore.user.onboardingStep = 1;
    if (!import.meta.server) {
      localStorage.setItem("nusift_pwa_profile", JSON.stringify(authStore.user));
    }
  }
  
  navigate.replace("/source-calibration");
};

const availableCategories = [
 { name: "Politics", i18nKey: "politics", icon: "policy" },
  { name: "Economy", i18nKey: "economy", icon: "payments" },
  { name: "Technology", i18nKey: "technology", icon: "memory" },
  { name: "Science", i18nKey: "science", icon: "science" },
  { name: "Health", i18nKey: "health", icon: "health_and_safety" },
  { name: "Environment", i18nKey: "environment", icon: "eco" },
  { name: "Entertainment", i18nKey: "entertainment", icon: "movie" },
  { name: "Culture", i18nKey: "culture", icon: "museum" },
  { name: "Sports", i18nKey: "sports", icon: "sports_soccer" },
  { name: "Society", i18nKey: "society", icon: "public" },
  { name: "Transport", i18nKey: "transport", icon: "directions_car" },
  { name: "Lifestyle", i18nKey: "lifestyle", icon: "style" },
  { name: "Gastronomy", i18nKey: "gastronomy", icon: "restaurant" },
  { name: "Real Estate", i18nKey: "real_estate", icon: "home" },
  { name: "Gardening", i18nKey: "gardening", icon: "yard" },
  { name: "Travel", i18nKey: "travel", icon: "flight" },
  { name: "Hobbies", i18nKey: "hobbies", icon: "sports_esports" },
  { name: "Education", i18nKey: "education", icon: "school" },
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
    await $api("/api/user/finalize-onboarding", {
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

    
      navigate.replace("/initialization-preloader-page");
    
  } catch (error) {
    console.error("Error during onboarding process:", error);
    isInitializing.value = false;
  }
};
</script>
