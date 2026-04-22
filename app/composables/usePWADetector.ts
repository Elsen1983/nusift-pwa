import { ref, shallowRef, onMounted } from 'vue';

/** ANCHOR GLOBAL-STATE
 * Declared outside the composable to act as a singleton across the application.
 * Retains state regardless of component mounting/unmounting.
 */
const isInstallable = ref<boolean>(false);
const deferredPrompt = shallowRef<any>(null);
const isIOS = ref<boolean>(false);
const isInStandalone = ref<boolean>(false);

// ANCHOR VITE-PWA-DEV-REGISTRATION
// Ez a sor kényszeríti a Service Worker regisztrálását kliens oldalon.
if (import.meta.client) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  }).catch(() => {
    // Csendes fail SSR vagy build környezetben
  });
}

// ANCHOR EARLY-INTERCEPTION
// Executed immediately upon file import, bypassing Vue lifecycle hooks.
// import.meta.client guarantees this strictly runs in the browser, preventing SSR crashes.
if (import.meta.client) {
  console.log("Checking if PWA install banner should be suppressed based on localStorage...");
  const ua: string = window.navigator.userAgent.toLowerCase();
  isIOS.value = /iphone|ipad|ipod/.test(ua) && !(window as any).MSStream;
  
  isInStandalone.value = 
    window.matchMedia('(display-mode: standalone)').matches || 
    (window.navigator as any).standalone === true;

  if (!isInStandalone.value) {
    const dismissed: string | null = localStorage.getItem('nusift_pwa_dismissed');
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Only attach the listener if the user hasn't actively suppressed it this month
    if (!dismissed || new Date(dismissed) < monthStart) {
      window.addEventListener('beforeinstallprompt', (e: Event) => {
        console.log('%c[PWA-Core] beforeinstallprompt intercepted', 'color: #00ffff; font-weight: bold;');
        e.preventDefault();
        deferredPrompt.value = e;
        isInstallable.value = true;
      }, { once: true }); // Critical optimization: Prevent memory leaks

      window.addEventListener('appinstalled', () => {
        console.log('%c[PWA-Core] Installation successful', 'color: #00ff00; font-weight: bold;');
        isInstallable.value = false;
        deferredPrompt.value = null;
        localStorage.setItem('nusift_pwa_installed', 'true');
      });
    }
  }
}

/** ANCHOR COMPOSABLE-EXPORT */
export default function usePWADetector() {
  const triggerInstall = async (): Promise<void> => {
    if (!deferredPrompt.value) return;

    deferredPrompt.value.prompt();
    const { outcome } = await deferredPrompt.value.userChoice;

    if (outcome === 'dismissed') {
      const today: string = new Date().toISOString().split('T')[0]!;
      localStorage.setItem('nusift_pwa_dismissed', today);
    } else {
      localStorage.setItem('nusift_pwa_installed', 'true');
    }

    // Reset state post-interaction
    deferredPrompt.value = null;
    isInstallable.value = false;
  };

  return {
    isInstallable,
    deferredPrompt,
    isIOS,
    isInStandalone,
    triggerInstall
  };
}