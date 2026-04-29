// plugins/hydrate.client.ts
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";

export default defineNuxtPlugin((nuxtApp) => {
  // A localStorage-ből csakis a böngészőben olvasunk, miután a Nuxt letöltött mindent
  const profileStr = localStorage.getItem("nusift_pwa_profile");
  
  if (profileStr) {
    try {
      const parsedUser = JSON.parse(profileStr);
      
      const authStore = useAuthStore();
      const agentStore = useAgentStore();

      // Csak akkor hidratálunk, ha a JWT miatt a Guard már felépítette a sessiont
      if (authStore.user) {
        // 1. Auth Store kiegészítése (Deep Merge a Pinia $patch segítségével)
        authStore.$patch({ user: parsedUser });

        // 2. Agent Store feltöltése a kalibrációs adatokkal
        agentStore.$patch({
          primaryRegion: parsedUser.primaryRegion || null,
          topSources: parsedUser.topSources || [],
          topInterests: parsedUser.topInterests || []
        });
      }
    } catch (error) {
      console.error("[Sovereign Hydration] Error parsing local profile", error);
    }
  }
});