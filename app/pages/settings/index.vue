<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-6 pb-20 overflow-visible">
    <section class="px-2">
      <div class="flex items-center gap-3 mb-1">
        <span class="material-symbols-outlined text-primary-container text-2xl" translate="no">settings</span>
        <h1 class="font-headline text-2xl font-bold text-on-surface tracking-tight">
          {{ $t("appSettings.title") }}
        </h1>
      </div>
      <p class="text-on-surface-variant text-sm font-body pl-[40px]">
        {{ $t("appSettings.description") }}
      </p>
    </section>

    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("appSettings.sections.notifications") }}
      </h4>
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-visible flex flex-col">
        <div class="w-full flex flex-col gap-4 p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-4 text-on-surface min-w-0">
              <span class="material-symbols-outlined text-on-surface-variant" translate="no">notifications</span>
              <div class="min-w-0">
                <span class="font-body text-[15px] font-medium block">
                  {{ $t("appSettings.notifications.title") }}
                </span>
                <span class="text-on-surface-variant text-[11px] font-label block">
                  {{ $t("appSettings.notifications.description") }}
                </span>
              </div>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                class="sr-only peer"
                :checked="pushEnabled"
                :disabled="isActivationToggleDisabled(pushState, pushEnabled, pushOperation)"
                @change="togglePush"
              />
              <div class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"></div>
            </label>
          </div>

          <div class="rounded-2xl border border-outline-variant/15 bg-surface-container/60 p-3 space-y-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="pushState === 'active' ? 'bg-emerald-400' : pushState === 'recoverable-error' ? 'bg-amber-300' : 'bg-on-surface-variant/50'"></span>
              <span class="font-label text-xs font-bold uppercase tracking-wider text-on-surface">{{ pushStateLabel }}</span>
            </div>
            <p class="text-xs leading-relaxed text-on-surface-variant">{{ pushStateDescription }}</p>
            <p class="text-[11px] leading-relaxed text-on-surface-variant/80">{{ $t("appSettings.notifications.inboxIndependent") }}</p>
            <p v-if="push.error.value" class="text-xs text-amber-200">{{ push.error.value }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="pushState === 'permission-default' || pushState === 'permission-granted-unsubscribed' || pushState === 'recoverable-error'" type="button" class="rounded-lg bg-primary-container px-4 py-2 text-[11px] font-headline font-bold uppercase tracking-widest text-on-primary-container transition hover:brightness-110 disabled:opacity-60" :disabled="pushOperation !== 'idle'" @click="enablePush">
                {{ pushState === 'recoverable-error' ? $t("appSettings.notifications.retry") : $t("appSettings.notifications.enable") }}
              </button>
              <button v-if="pushState === 'active' || (pushState === 'permission-denied' && pushEnabled)" type="button" class="rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-[11px] font-headline font-bold uppercase tracking-widest text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-60" :disabled="pushOperation !== 'idle'" @click="disablePush">
                {{ $t("appSettings.notifications.disable") }}
              </button>
              <button type="button" class="rounded-lg border border-outline-variant/30 bg-surface-container hover:bg-surface-container-high px-4 py-2 text-[11px] font-headline uppercase tracking-widest text-on-surface-variant transition disabled:opacity-60" :disabled="pushOperation !== 'idle'" @click="refreshPushStatus">
                {{ $t("appSettings.notifications.refresh") }}
              </button>
              <button type="button" class="rounded-lg border border-outline-variant/30 bg-surface-container hover:bg-surface-container-high px-4 py-2 text-[11px] font-headline uppercase tracking-widest text-on-surface-variant transition" @click="sendTestPush">
                {{ $t("appSettings.notifications.test") }}
              </button>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-center gap-4 text-on-surface min-w-0">
                <span class="material-symbols-outlined text-on-surface-variant" translate="no">bolt</span>
                <div class="min-w-0">
                  <span class="font-body text-[15px] font-medium block">{{ $t("appSettings.notifications.breaking") }}</span>
                  <span class="text-on-surface-variant text-[11px] font-label">{{ $t("appSettings.notifications.breakingDesc") }}</span>
                </div>
              </div>
              <label class="relative inline-flex items-center cursor-pointer shrink-0">
                <input type="checkbox" v-model="breakingEnabled" @change="updateBreaking" class="sr-only peer" />
                <div class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"></div>
              </label>
            </div>

            <div class="flex items-start gap-4">
              <span class="material-symbols-outlined text-on-surface-variant shrink-0 mt-0.5">schedule</span>
              <div class="min-w-0 flex-1">
                <span class="font-body text-[15px] font-medium block">{{ $t("appSettings.notifications.dailyTiming") }}</span>
                <span class="text-on-surface-variant text-[11px] font-label block">{{ $t("appSettings.notifications.dailyTimingDesc") }}</span>
                <div class="mt-3 grid grid-cols-3 gap-1">
                  <label
                    v-for="option in scheduleOptions"
                    :key="option.value"
                    class="flex items-center gap-1 transition-colors cursor-pointer min-w-0"
                    :class="scheduleSlot === option.value ? '' : ''"
                  >
                    <input
                      type="radio"
                      name="scheduleSlot"
                      class="sr-only"
                      :value="option.value"
                      :checked="scheduleSlot === option.value"
                      @change="selectSchedule(option.value)"
                    />
                    <span class="h-4 w-4 rounded-full border flex items-center justify-center shrink-0" :class="scheduleSlot === option.value ? 'border-primary-container' : 'border-outline-variant/40'">
                      <span v-if="scheduleSlot === option.value" class="h-2 w-2 rounded-full bg-primary-container"></span>
                    </span>
                    <span class="font-label text-xs sm:text-sm font-bold text-on-surface truncate">{{ option.label }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("appSettings.sections.appearance") }}
      </h4>
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col">
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">              <span class="material-symbols-outlined text-on-surface-variant" translate="no">
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
            <input type="checkbox" v-model="isDarkMode" class="sr-only peer" />
            <div class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"></div>
          </label>
        </div>
      </div>
    </section>

    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("appSettings.sections.language") }}
      </h4>
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden flex flex-col">
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant" translate="no">language</span>
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
          </div>
        </div>

        <div class="h-px w-full bg-outline-variant/10"></div>

        <div class="p-4">
          <div class="grid grid-cols-2 gap-3">
            <button
              v-for="lang in availableLanguages"
              :key="lang.code"
              @click="selectLanguage(lang)"
              :disabled="!lang.enabled"
              class="flex items-center gap-3 py-1 px-2 rounded-xl border transition-all text-left group"
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
                  class="text-primary-container text-[9px] font-label uppercase tracking-wider"
                >
                  {{ $t("appSettings.language.active") }}
                </span>
                <span
                  v-else-if="!lang.enabled"
                  class="text-on-surface-variant text-[9px] font-label uppercase tracking-wider"
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

    <section class="space-y-2">
      <h4 class="text-[13px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">
        {{ $t("appSettings.sections.about") }}
      </h4>
      <div class="bg-surface-container-low rounded-3xl border border-outline-variant/10 shadow-lg overflow-hidden">
        <div class="w-full flex items-center justify-between p-4">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant" translate="no">info</span>
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
import { useAuthStore } from "~/stores/auth";
import { usePushNotifications } from "~/composables/usePushNotifications";
import { canActivatePush, decidePushToggle, isActivationToggleDisabled } from "./push-settings-policy";

definePageMeta({ layout: "app-layout" });

const { locale, setLocale } = useI18n();
const authStore = useAuthStore();
const colorMode = useColorMode();
const push = usePushNotifications();

const pushEnabled = computed(() => push.enabled.value);
const pushStatus = computed(() => push.status.value);
const pushOperation = computed(() => push.operation.value);
const pushState = computed(() => push.state.value);
const pushStateLabel = computed(() => {
  const key = `appSettings.notifications.states.${pushState.value}`;
  return $t(key);
});
const pushStateDescription = computed(() => {
  if (pushState.value === "permission-denied") return $t("appSettings.notifications.permissionDeniedHelp");
  if (pushState.value === "active") return $t("appSettings.notifications.activeDescription");
  return $t(`appSettings.notifications.stateDescriptions.${pushState.value}`);
});
const scheduleSlot = ref<"MORNING" | "NOON" | "EVENING">("MORNING");
const breakingEnabled = ref(true);
const scheduleOptions = [
  { value: "MORNING", label: $t("appSettings.notifications.morning") },
  { value: "NOON", label: $t("appSettings.notifications.noon") },
  { value: "EVENING", label: $t("appSettings.notifications.evening") },
] as const;

const isDarkMode = computed({
  get: () => colorMode.value === "dark",
  set: (val: boolean) => {
    colorMode.preference = val ? "dark" : "light";
  },
});

type LocaleCode = "en" | "hu" | "fr" | "de" | "pl" | "es";

const availableLanguages: { code: LocaleCode; name: string; icon: string; enabled: boolean }[] = [
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

const selectLanguage = async (lang: (typeof availableLanguages)[number]) => {
  if (!lang.enabled) return;
  localStorage.setItem("nusift_preferred_language", lang.code);
  if (authStore.user) {
    authStore.user.preferredLanguage = lang.code;
    localStorage.setItem("nusift_pwa_profile", JSON.stringify(authStore.user));
  }
  try {
    await $fetch("/api/user/profile/identity", {
      method: "PUT",
      body: { preferredLanguage: lang.code },
    });
  } catch (error) {
    console.warn("[settings] failed to persist preferredLanguage", error);
  }
  await setLocale(lang.code);
  locale.value = lang.code;
};

const enablePush = async () => {
  await push.subscribe();
};

const refreshPushStatus = async () => {
  await push.refreshStatus();
};

const disablePush = async () => {
  await push.unsubscribe();
};

const togglePush = async (event: Event) => {
  const nextEnabled = (event.target as HTMLInputElement)?.checked ?? false;
  // Denied permission is authoritative only while no persisted subscription
  // is active; an active endpoint must remain disableable.
  const action = decidePushToggle(pushState.value, pushEnabled.value, nextEnabled);
  if (action === "noop") return;
  if (action === "enable") await enablePush();
  else await disablePush();
};

const sendTestPush = async () => {
  const res = await $fetch<{ unreadCount?: number }>("/api/notifications/test", { method: "POST", body: {} });
  if (import.meta.client) {
    const unreadNotificationCount = useState<number>("unreadNotificationCount", () => 0);
    unreadNotificationCount.value = res.unreadCount || 0;
    window.dispatchEvent(new Event("nusift:notifications:update"));
    const { $refreshUnreadNotifications } = useNuxtApp();
    await $refreshUnreadNotifications?.();
  }
};

const updateSchedule = async () => {
  await push.setScheduleSlot(scheduleSlot.value);
};

const selectSchedule = async (slot: "MORNING" | "NOON" | "EVENING") => {
  scheduleSlot.value = slot;
  await updateSchedule();
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
