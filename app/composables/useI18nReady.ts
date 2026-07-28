/**
 * useI18nReady — detects whether vue-i18n locale messages are loaded.
 *
 * On first client render after a deployment/update, locale message chunks
 * may not yet be available (lazy-loaded). This composable checks a small
 * set of known keys: if $t(key) returns the key itself, messages are not
 * loaded yet.
 *
 * Returns:
 *  - isReady: Ref<boolean> — true when messages resolve to real text
 *  - safeT: (key: string, fallback: string) => string — returns translated
 *    text or a human-readable fallback instead of raw keys
 */

import { ref, computed, onMounted, onBeforeUnmount } from "vue";

/** Known auth-page keys that must resolve for a usable login screen. */
const AUTH_PROBE_KEYS = [
  "auth.heading.login",
  "auth.buttons.continue_google",
  "auth.footer.terms",
] as const;

/** Timeout after which the guard stops blocking and falls back to safeT strings. */
const I18N_READY_TIMEOUT_MS = 3000;

export function useI18nReady() {
  const { t, locale } = useI18n();
  const timedOut = ref(false);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (import.meta.client) {
    onMounted(() => {
      timeoutId = setTimeout(() => {
        timedOut.value = true;
      }, I18N_READY_TIMEOUT_MS);
    });

    onBeforeUnmount(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });
  }

  const isReady = computed(() => {
    // If timeout expired, treat as ready (will use safeT fallbacks)
    if (timedOut.value) return true;
    // Probe multiple keys — all must resolve for true readiness
    return AUTH_PROBE_KEYS.every((key) => {
      const result = t(key);
      return typeof result === "string" && result !== key && result.length > 0;
    });
  });

  /**
   * Safe translation: returns the translated value, or a human-readable
   * fallback string instead of the raw i18n key.
   */
  const safeT = (key: string, fallback: string): string => {
    const result = t(key);
    if (typeof result === "string" && result !== key && result.length > 0) {
      return result;
    }
    return fallback;
  };

  return { isReady, safeT, locale, timedOut };
}
