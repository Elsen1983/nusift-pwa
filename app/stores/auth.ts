// stores/auth.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { useAgentStore } from "./agent";

export const useAuthStore = defineStore("auth", () => {

  const agentStore = useAgentStore();

  // ANCHOR STATE
  const user = ref<{
    id: string;
    email: string;
    createdAt: string;
    onboardingStep: number;
  } | null>(null);
  
  const isLoading = ref(false);
  const authError = ref<string | null>(null);

  // PWA OFFLINE FALLBACK
  // if (!import.meta.server && !user.value) {
  //   const offlineProfile = localStorage.getItem("nusift_pwa_profile");
  //   if (offlineProfile) {
  //     try {
  //       const parsed = JSON.parse(offlineProfile);
  //       user.value = parsed;
        
  //       // F5 ESETÉN IS TÖLTSÜK VISSZA AZ AGENT ADATAIT!
  //       const aStore = useAgentStore();
  //       aStore.primaryRegion = parsed.primaryRegion || null;
  //       aStore.topSources = parsed.topSources || [];
  //       aStore.topInterests = parsed.topInterests || [];
        
  //     } catch (e) {
  //       console.error("Hibás PWA profil a cache-ben");
  //     }
  //   }
  // }

  // ANCHOR MANUAL RESET
  /** * Mivel Setup Store-t használunk, manuálisan kell implementálnunk a reset-et.
   * Ezt fogja hívni az app-layout.vue logout közben.
   */
  function $reset() {
    user.value = null;
    isLoading.value = false;
    authError.value = null;

    if (!import.meta.server) {
      localStorage.removeItem("nusift_pwa_profile");
    }
  }

  // ANCHOR ACTIONS
  const registerIdentity = async (
    emailPayload: string,
    passwordPayload: string,
  ) => {
    isLoading.value = true;
    authError.value = null;

    try {
      const response = await $fetch("/api/auth/register", {
        method: "POST",
        body: {
          email: emailPayload,
          password: passwordPayload,
        },
      });
      return true;
    } catch (error: any) {
      authError.value = error.data?.statusMessage || "Registration failed.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const loginIdentity = async (
    emailPayload: string,
    passwordPayload: string,
  ) => {
    isLoading.value = true;
    authError.value = null;

    try {
      const response = await $fetch("/api/auth/login", {
        method: "POST",
        body: {
          email: emailPayload,
          password: passwordPayload,
        },
      });

      user.value = response.user;

      // 4. Áttöltjük a kalibrációs adatokat az Agent Store-ba!
      if (response.user) {
        agentStore.primaryRegion = response.user.primaryRegion || null;
        agentStore.topSources = response.user.topSources || [];
        // BUGFIX: Force TypeScript to accept the new JSON structure from the DB
        agentStore.topInterests = (response.user.topInterests || []) as any;
      }

      if (!import.meta.server) {
        localStorage.setItem(
          "nusift_pwa_profile",
          JSON.stringify(response.user),
        );
      }

      return true;
    } catch (error: any) {
      authError.value = error.data?.statusMessage || "Authentication failure.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const logoutIdentity = async () => {
    try {
      await $fetch("/api/auth/logout", { method: "POST" });
      $reset(); // A belső reset hívása
      return true;
    } catch (error) {
      console.error("Logout API failed", error);
      return false;
    }
  };

  // Fontos: mindent vissza kell adni, amit kívülről el akarunk érni!
  return {
    user,
    isLoading,
    authError,
    registerIdentity,
    loginIdentity,
    logoutIdentity,
    $reset,
  };
});
