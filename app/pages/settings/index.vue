<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-6 pb-20 overflow-hidden">
    <!-- PAGE HEADER -->
    <section class="px-2">
      <div class="flex items-center gap-3 mb-1">
        <span class="material-symbols-outlined text-primary-container text-2xl">settings</span>
        <h1 class="font-headline text-2xl font-bold text-on-surface tracking-tight">
          {{ $t("appSettings.title") }}
        </h1>
      </div>
      <p class="text-on-surface-variant text-sm font-body pl-[40px]">
        {{ $t("appSettings.description") }}
      </p>
    </section>

    <!-- NOTIFICATIONS -->
    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("appSettings.sections.notifications") }}
      </h4>
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col">
        <div class="w-full flex flex-col gap-4 p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-4 text-on-surface min-w-0">
              <span class="material-symbols-outlined text-on-surface-variant">notifications</span>
              <div class="min-w-0">
                <span class="font-body text-[15px] font-medium block">
                  {{ $t("appSettings.notifications.title") }}
                </span>
                <span class="text-on-surface-variant text-[11px] font-label block">
                  {{ $t("appSettings.notifications.description") }}
                </span>
              </div>
            </div>
            <span class="text-[11px] font-label uppercase tracking-widest px-2 py-1 rounded-full border"
              :class="pushEnabled ? 'border-success/30 text-success' : 'border-outline-variant/30 text-on-surface-variant'">
              {{ pushEnabled ? $t("appSettings.notifications.enabled") : $t("appSettings.notifications.disabled") }}
            </span>
          </div>

          <div class="flex flex-wrap gap-3">
            <button
              class="px-4 py-3 rounded-lg border text-[11px] font-headline uppercase tracking-widest transition-colors"
              :class="pushEnabled ? 'border-outline-variant/30 bg-surface-container hover:bg-surface-container-high text-on-surface-variant' : 'border-primary-container/30 bg-primary-container/10 hover:bg-primary-container/20 text-primary-container'"
              @click="pushEnabled ? disablePush() : enablePush()"
            >
              {{ pushEnabled ? $t("appSettings.notifications.disable") : $t("appSettings.notifications.enable") }}
            </button>
            <button
              class="px-4 py-3 rounded-lg border border-outline-variant/30 bg-surface-container hover:bg-surface-container-high text-on-surface-variant text-[11px] font-headline uppercase tracking-widest transition-colors"
              @click="sendTestPush"
            >
              {{ $t("appSettings.notifications.test") }}
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="flex items-center justify-between gap-3 p-3 rounded-xl border border-outline-variant/20 bg-surface-container">
              <div>
                <span class="font-body text-[14px] font-medium block">{{ $t("appSettings.notifications.dailyTiming") }}</span>
                <span class="text-on-surface-variant text-[11px] font-label">{{ $t("appSettings.notifications.dailyTimingDesc") }}</span>
              </div>
              <select
                v-model="scheduleSlot"
                @change="updateSchedule"
                class="bg-transparent text-on-surface-variant border border-outline-variant/30 rounded-lg px-3 py-2 text-sm"
              >
                <option value="MORNING">{{ $t("appSettings.notifications.morning") }}</option>
                <option value="NOON">{{ $t("appSettings.notifications.noon") }}</option>
                <option value="EVENING">{{ $t("appSettings.notifications.evening") }}</option>
              </select>
            </label>

            <label class="flex items-center justify-between gap-3 p-3 rounded-xl border border-outline-variant/20 bg-surface-container">
              <div>
                <span class="font-body text-[14px] font-medium block">{{ $t("appSettings.notifications.breaking") }}</span>
                <span class="text-on-surface-variant text-[11px] font-label">{{ $t("appSettings.notifications.breakingDesc") }}</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="breakingEnabled" @change="updateBreaking" class="sr-only peer" />
                <div class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"></div>
              </label>
            </label>
          </div>
        </div>
      </div>
    </section>

    <!-- APPEARANCE -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("appSettings.sections.appearance") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col"
      >
        <!-- Dark Mode Toggle -->
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant">
              {{ isDarkMode ? "dark_mode" : "light_mode" }}
            </span>
            <div>
              <span class="font-body text-[15px] font-medium block">
                {{ $t("appSettings.darkMode.label") }}
              </span>
              <span class="text-on-surface-variant text-[11px] font-label">
                {{ isDarkMode ? $t("appSettings.darkMode.current_dark") : $t("appSettings.darkMode.current_light") }}
              </span>
            </div>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              v-model="isDarkMode"
              class="sr-only peer"
            />
            <div
              class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"
            ></div>
          </label>
        </div>

      </div>
    </section>

    <!-- LANGUAGE -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("appSettings.sections.language") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col"
      >
        <!-- Current Language Display -->
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant">
              language
            </span>
            <div>
              <span class="font-body text-[15px] font-medium block">
                {{ $t("appSettings.language.label") }}
              </span>
              <span class="text-on-surface-variant text-[11px] font-label">
                {{ $t("appSettings.language.description") }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-on-surface-variant text-[13px] font-label">
              {{ currentLanguageName }}
            </span>
            <span
              class="material-symbols-outlined text-outline-variant text-lg"
            >chevron_right</span>
          </div>
        </div>

        <div class="h-px w-full bg-outline-variant/10"></div>

        <!-- Language Grid -->
        <div class="p-4">
          <div class="grid grid-cols-2 gap-3">
            <button
              v-for="lang in availableLanguages"
              :key="lang.code"
              @click="selectLanguage(lang)"
              :disabled="!lang.enabled"
              class="flex items-center gap-3 p-3 rounded-xl border transition-all text-left group"
              :class="[
                lang.enabled
                  ? locale === lang.code
                    ? 'border-primary-container/50 bg-primary-container/10'
                    : 'border-outline-variant/30 bg-surface-container hover:bg-surface-container-high hover:border-primary-container/50 cursor-pointer'
                  : 'border-outline-variant/10 bg-surface-container-lowest opacity-50 cursor-not-allowed'
              ]"
            >
              <div class="shrink-0 shadow-sm group-hover:scale-110 transition-transform duration-300">
                <Icon :name="lang.icon" class="text-2xl" />
              </div>
              <div class="min-w-0 flex-1">
                <span class="font-label text-sm font-bold text-on-surface block truncate">
                  {{ lang.name }}
                </span>
                <span
                  v-if="locale === lang.code"
                  class="text-primary-container text-[10px] font-label uppercase tracking-wider"
                >
                  {{ $t("appSettings.language.active") }}
                </span>
                <span
                  v-else-if="!lang.enabled"
                  class="text-on-surface-variant text-[10px] font-label uppercase tracking-wider"
                >
                  {{ $t("appSettings.language.coming_soon") }}
                </span>
              </div>
              <span
                v-if="locale === lang.code"
                class="material-symbols-outlined text-primary-container text-lg shrink-0"
              >check_circle</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ABOUT -->
    <section class="space-y-2">
      <h4
        class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4"
      >
        {{ $t("appSettings.sections.about") }}
      </h4>
      <div
        class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden"
      >
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant">info</span>
            <span class="font-body text-[15px] font-medium">
              {{ $t("appSettings.about.version") }}
            </span>
          </div>
          <span class="text-on-surface-variant text-[13px] font-label">
            {{ $t("preloaderFirst.version") }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePushNotifications } from "~/composables/usePushNotifications";

definePageMeta({
  layout: "app-layout",
});

const { locale, t } = useI18n();
const colorMode = useColorMode();
const push = usePushNotifications();

const pushEnabled = computed(() => push.enabled.value);
const scheduleSlot = ref<"MORNING" | "NOON" | "EVENING">("MORNING");
const breakingEnabled = ref(true);

// --- DARK MODE TOGGLE ---
const isDarkMode = computed({
  get: () => colorMode.value === "dark",
  set: (val: boolean) => {
    colorMode.preference = val ? "dark" : "light";
  },
});

// --- LANGUAGE ---
const availableLanguages = [
  { code: "en", name: "English", icon: "circle-flags:gb", enabled: true },
  { code: "hu", name: "Magyar", icon: "circle-flags:hu", enabled: true },
  { code: "fr", name: "Français", icon: "circle-flags:fr", enabled: false },
  { code: "de", name: "Deutsch", icon: "circle-flags:de", enabled: false },
  { code: "pl", name: "Polski", icon: "circle-flags:pl", enabled: false },
  { code: "es", name: "Español", icon: "circle-flags:es", enabled: false },
];

const currentLanguageName = computed(() => {
  const current = availableLanguages.find((l) => l.code === locale.value);
  return current?.name || "English";
});

const selectLanguage = (lang: (typeof availableLanguages)[number]) => {
  if (!lang.enabled) return;
  localStorage.setItem("nusift_preferred_language", lang.code);
  locale.value = lang.code as "en" | "hu";
};

const enablePush = async () => {
  await push.subscribe();
};

const disablePush = async () => {
  await push.unsubscribe();
};

const sendTestPush = async () => {
  await $fetch("/api/notifications/test", { method: "POST", body: {} });
  if (import.meta.client) {
    window.dispatchEvent(new Event("nusift:notifications:update"));
    const { $refreshUnreadNotifications } = useNuxtApp();
    await $refreshUnreadNotifications?.();
  }
};

const updateSchedule = async () => {
  await push.setScheduleSlot(scheduleSlot.value);
};

const updateBreaking = async () => {
  await push.setBreakingEnabled(breakingEnabled.value);
};

onMounted(async () => {
  await push.refreshStatus();
  scheduleSlot.value = push.scheduleSlot.value;
  breakingEnabled.value = push.breakingEnabled.value;
});
</script>
