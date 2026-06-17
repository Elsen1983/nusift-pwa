import { defineNuxtPlugin } from '#app';

export default defineNuxtPlugin((nuxtApp) => {
  const router = (nuxtApp as any).$router || (nuxtApp as any).router;
  if (!router) {
    console.warn('[unsaved] router not found in plugin context');
    return;
  }

  // Navigation guard: resolve the store at runtime to avoid init-order issues
  router.beforeEach(async (to: any, from: any) => {
    try {
      const mod = await import('~/stores/unsaved');
      const unsaved = mod.useUnsavedStore();
      if (unsaved.anyDirty) {
        console.debug('[unsaved] navigation blocked by dirty forms');
        const confirmLeave = window.confirm(
          'You have unsaved changes. Leave page without saving?'
        );
        if (!confirmLeave) return false;
      }
    } catch (e) {
      // If store not available, allow navigation and log
      console.warn('[unsaved] could not access store in beforeEach', e);
    }
    return true;
  });

  // Browser unload (close / refresh)
  if (process.client) {
    window.addEventListener('beforeunload', (e) => {
        try {
          const mod = await import('~/stores/unsaved');
          const unsaved = mod.useUnsavedStore();
          if (unsaved.anyDirty) {
            e.preventDefault();
            // Chrome requires returnValue to be set
            (e as any).returnValue = '';
            return '';
          }
        } catch (err) {
          console.warn('[unsaved] could not access store in beforeunload', err);
        }
    });
  }
});
