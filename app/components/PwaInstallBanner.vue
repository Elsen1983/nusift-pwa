<template>
  <transition name="fade">
    <div v-if="showInstallUI" class="pwa-toast glass-panel">
      <p class="mb-4 font-headline text-sm font-bold text-on-surface uppercase tracking-wide">
        Install NuSift on your device?
      </p>
      <div class="flex justify-center gap-3">
        <button 
          class="min-btn-width bg-primary-container/10 hover:bg-primary-container/20 text-primary-container font-headline text-[11px] font-bold uppercase tracking-widest px-4 py-3 rounded-lg transition-colors border border-primary-container/30" 
          @click="installApp"
        >
          Install
        </button>
        <button 
          class="min-btn-width bg-surface-container hover:bg-surface-container-high text-on-surface-variant font-headline text-[11px] font-bold uppercase tracking-widest px-4 py-3 rounded-lg transition-colors border border-outline-variant/30" 
          @click="dismiss"
        >
          Not now
        </button>
      </div>
    </div>
  </transition>

  <transition name="fade">
    <div
      v-if="isFirefox && !isInStandalone && !dismissedThisMonth"
      class="pwa-toast glass-panel"
    >
      <p class="font-body text-sm text-on-surface mb-4">
        To install this app in Firefox, open the browser menu and select
        <strong class="text-primary-container">"Install"</strong> or <strong class="text-primary-container">"Add to App Library"</strong>.
      </p>
      <button 
        class="w-full py-3 bg-surface text-on-surface font-label text-xs uppercase tracking-widest rounded-lg border border-outline-variant/50 hover:bg-surface-container-high transition-colors" 
        @click="dismiss"
      >
        Got it
      </button>
    </div>
  </transition>

  <transition name="fade">
    <div v-if="!showInstallUI && isIOS && !isInStandalone && !dismissedThisMonth" class="pwa-toast glass-panel">
      <p class="font-body text-sm text-on-surface mb-4">
        To install this app, tap <strong class="text-primary-container">Share</strong> → <strong class="text-primary-container">Add to Home Screen</strong> in Safari.
      </p>
      <button 
        class="w-full py-3 bg-surface text-on-surface font-label text-xs uppercase tracking-widest rounded-lg border border-outline-variant/50 hover:bg-surface-container-high transition-colors" 
        @click="dismiss"
      >
        Got it
      </button>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watchEffect } from 'vue';
//import useInstallPrompt from '@/composables/useInstallPrompt'; // Ensure the target file is renamed to .ts

const { isInstallable, triggerInstall, isIOS, isInStandalone } = usePWADetector();

// Explicit boolean type and SSR safety check
const isFirefox: boolean = import.meta.client 
  ? window.navigator.userAgent.toLowerCase().includes('firefox')
  : false;

const showInstallUI = ref<boolean>(false);
const dismissedThisMonth = ref<boolean>(false);

const checkSuppressed = (): void => {
  if (!import.meta.client) return;

  const dismissed: string | null = localStorage.getItem('pwaDismissed');
  if (dismissed) {
    const now = new Date();
    const dismissedDate = new Date(dismissed);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (dismissedDate >= monthStart) {
      dismissedThisMonth.value = true;
    }
  }
};

checkSuppressed();

watchEffect(() => {
  if (isInstallable.value && !dismissedThisMonth.value) {
    showInstallUI.value = true;
  }
});

const installApp = async (): Promise<void> => {
  await triggerInstall();
  showInstallUI.value = false;
};

const dismiss = (): void => {
  if (!import.meta.client) return;

  // Utilizing the non-null assertion operator (!) to satisfy strict string typing
  const today: string = new Date().toISOString().split('T')[0]!;
  localStorage.setItem('pwaDismissed', today);
  showInstallUI.value = false;
  dismissedThisMonth.value = true;
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
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
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.8);
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
    transform: translate(-50%, 15px); /* Maintain horizontal centering during animation */
  }
}
</style>