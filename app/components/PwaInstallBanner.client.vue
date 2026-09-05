<template>
  <div>
    <transition name="fade">
      <div 
        v-if="showInstallUI" 
        class="pwa-toast bg-surface-container-highest/95 backdrop-blur-xl border border-outline-variant/30 shadow-2xl"
      >
        <p
          class="mb-4 font-headline text-sm font-bold text-on-surface uppercase tracking-wide"
        >
          {{ safeT("auth.pwa.install_prompt", pwaFallbacks.installPrompt) }}
        </p>
        <div class="flex justify-center gap-3">
          <button
            class="min-btn-width bg-primary-container/10 hover:bg-primary-container/20 text-primary-container font-headline text-[11px] font-bold uppercase tracking-widest px-4 py-3 rounded-lg transition-colors border border-primary-container/30"
            @click="installApp"
          >
            {{ safeT("auth.pwa.buttons.install", pwaFallbacks.install) }}
          </button>
          <button
            class="min-btn-width bg-surface-container hover:bg-surface-container-high text-on-surface-variant font-headline text-[11px] font-bold uppercase tracking-widest px-4 py-3 rounded-lg transition-colors border border-outline-variant/30"
            @click="dismiss"
          >
            {{ safeT("auth.pwa.buttons.not_now", pwaFallbacks.notNow) }}
          </button>
        </div>
      </div>
    </transition>

    <transition name="fade">
      <div
        v-if="isFirefox && !isInStandalone && !dismissedThisMonth"
        class="pwa-toast bg-surface-container-highest/95 backdrop-blur-xl border border-outline-variant/30 shadow-2xl"
      >
        <i18n-t
          v-if="hasFirefoxInstructions"
          keypath="auth.pwa.firefox_instructions"
          tag="p"
          class="font-body text-sm text-on-surface mb-4"
        >
          <template #action1>
            <strong class="text-primary-container">
              {{ safeT("auth.pwa.firefox_action1", pwaFallbacks.firefoxAction1) }}
            </strong>
          </template>
          <template #action2>
            <strong class="text-primary-container">
              {{ safeT("auth.pwa.firefox_action2", pwaFallbacks.firefoxAction2) }}
            </strong>
          </template>
        </i18n-t>
        <p v-else class="font-body text-sm text-on-surface mb-4">
          {{ pwaFallbacks.firefoxInstructions }}
        </p>
        
        <button
          class="w-full py-3 bg-surface text-on-surface font-label text-xs uppercase tracking-widest rounded-lg border border-outline-variant/50 hover:bg-surface-container-high transition-colors"
          @click="dismiss"
        >
          {{ safeT("auth.pwa.buttons.got_it", pwaFallbacks.gotIt) }}
        </button>
      </div>
    </transition>

    <transition name="fade">
      <div
        v-if="!showInstallUI && isIOS && !isInStandalone && !dismissedThisMonth"
        class="pwa-toast bg-surface-container-highest/95 backdrop-blur-xl border border-outline-variant/30 shadow-2xl"
      >
        <i18n-t
          v-if="hasIosInstructions"
          keypath="auth.pwa.ios_instructions"
          tag="p"
          class="font-body text-sm text-on-surface mb-4"
        >
          <template #action1>
            <strong class="text-primary-container">
              {{ safeT("auth.pwa.ios_action1", pwaFallbacks.iosAction1) }}
            </strong>
          </template>
          <template #action2>
            <strong class="text-primary-container">
              {{ safeT("auth.pwa.ios_action2", pwaFallbacks.iosAction2) }}
            </strong>
          </template>
        </i18n-t>
        <p v-else class="font-body text-sm text-on-surface mb-4">
          {{ pwaFallbacks.iosInstructions }}
        </p>

        <button
          class="w-full py-3 bg-surface text-on-surface font-label text-xs uppercase tracking-widest rounded-lg border border-outline-variant/50 hover:bg-surface-container-high transition-colors"
          @click="dismiss"
        >
          {{ safeT("auth.pwa.buttons.got_it", pwaFallbacks.gotIt) }}
        </button>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const { $pwa } = useNuxtApp();
const { safeT, locale } = useI18nReady();

const PWA_FALLBACKS = {
  en: {
    installPrompt: "Install NuSift on your device?",
    install: "Install",
    notNow: "Not now",
    gotIt: "Got it",
    firefoxInstructions:
      'To install this app in Firefox, open the browser menu and select "Install" or "Add to App Library".',
    firefoxAction1: '"Install"',
    firefoxAction2: '"Add to App Library"',
    iosInstructions:
      'To install this app in Safari, tap "Share", then "Add to Home Screen".',
    iosAction1: "Share",
    iosAction2: "Add to Home Screen",
  },
  hu: {
    installPrompt: "Telepíted a NuSift-et az eszközödre?",
    install: "Telepítés",
    notNow: "Most nem",
    gotIt: "Értem",
    firefoxInstructions:
      'A Firefoxban való telepítéshez nyisd meg a böngésző menüjét, és válaszd a "Telepítés" vagy a "Hozzáadás az alkalmazástárhoz" lehetőséget.',
    firefoxAction1: '"Telepítés"',
    firefoxAction2: '"Hozzáadás az alkalmazástárhoz"',
    iosInstructions:
      'A telepítéshez bökj a "Megosztás", majd a "Főképernyőhöz adás" gombra a Safariban.',
    iosAction1: "Megosztás",
    iosAction2: "Főképernyőhöz adás",
  },
} as const;

const pwaFallbacks = computed(() =>
  locale.value === "hu" ? PWA_FALLBACKS.hu : PWA_FALLBACKS.en,
);
const hasFirefoxInstructions = computed(
  () => safeT("auth.pwa.firefox_instructions", "") !== "",
);
const hasIosInstructions = computed(
  () => safeT("auth.pwa.ios_instructions", "") !== "",
);

const { isInstallable, triggerInstall, isIOS, isInStandalone } =
  usePWADetector();

// Explicit boolean type and SSR safety check
const isFirefox: boolean = import.meta.client
  ? window.navigator.userAgent.toLowerCase().includes("firefox")
  : false;
console.warn("isFirefox:", isFirefox);

const dismissedThisMonth = ref<boolean>(false);

const checkSuppressed = (): void => {
  if (!import.meta.client) return;

  const dismissed: string | null = localStorage.getItem("nusift_pwa_dismissed");
  if (dismissed) {
    const now = new Date();
    const dismissedDate = new Date(dismissed);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (dismissedDate >= monthStart) {
      dismissedThisMonth.value = true;
    }
  }
};
console.warn("Checking if PWA install banner should be suppressed based on localStorage...");

checkSuppressed();

const showInstallUI = computed(() => {
  return (isInstallable.value || $pwa?.showInstallPrompt) && !dismissedThisMonth.value;
});

const installApp = async (): Promise<void> => {
  if ($pwa?.showInstallPrompt) {
    await $pwa.install();
  } else {
    await triggerInstall();
  }
  dismissedThisMonth.value = true;
};

const dismiss = (): void => {
  if (!import.meta.client) return;

  // Utilizing the non-null assertion operator (!) to satisfy strict string typing
  const today: string = new Date().toISOString().split("T")[0]!;
  localStorage.setItem("nusift_pwa_dismissed", today);
  dismissedThisMonth.value = true;
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(15px);
}

.pwa-toast {
  position: fixed;
  bottom: 2rem;
  left: 1rem;
  right: 1rem;
  padding: 1.5rem;
  border-radius: 16px;
  z-index: 9999;
  text-align: center;
  /* Hardkódolt border és box-shadow eltávolítva, ezt most a Tailwind kezeli a témának megfelelően! */
}

.min-btn-width {
  min-width: 130px;
}

/* Desktop optimization: Center the toast instead of spanning full width */
@media (min-width: 768px) {
  .pwa-toast {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: 100%;
    max-width: 420px;
  }

  .fade-enter-from,
  .fade-leave-to {
    opacity: 0;
    transform: translate(
      -50%,
      15px
    ); /* Maintain horizontal centering during animation */
  }
}
</style>
