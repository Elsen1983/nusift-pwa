// composables/useSovereignNavigate.ts
export const useSovereignNavigate = () => {
  const router = useRouter();
  const localePath = useLocalePath();

  /**
   * Standard SPA navigáció (router.push) automatikus nyelvi előtaggal
   */
  const push = (to: string | object) => {
    return router.push(localePath(to));
  };

  /**
   * Előzményeket felülíró SPA navigáció (router.replace) automatikus nyelvi előtaggal
   */
  const replace = (to: string | object) => {
    return router.replace(localePath(to));
  };

  /**
   * Kemény böngésző-újratöltést kikényszerítő navigáció (Zombi session-ök ellen)
   * Automatikusan kezeli a nyelvi kontextust a kliensoldalon
   */
  const hardRedirect = (to: string) => {
    if (import.meta.client) {
      window.location.href = localePath(to);
    }
  };

  return {
    push,
    replace,
    hardRedirect,
  };
};