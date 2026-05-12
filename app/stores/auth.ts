// stores/auth.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { useAgentStore } from "./agent";

/** ANCHOR TYPE-DEFINITIONS
 * Ensures strict type-safety for user data flowing from the 
 * verified backend handshake to the frontend state.
 */
interface UserProfile {
  id: string;
  email: string;
  onboardingStep: number;
  createdAt?: string; 
  primaryRegion: string | null;
  topSources: string[];
  topInterests: any; 
}

export const useAuthStore = defineStore("auth", () => {
  const agentStore = useAgentStore();

  // ANCHOR STATE
  const user = ref<UserProfile | null>(null);
  const isLoading = ref(false);
  const authError = ref<string | null>(null);

  // ANCHOR UTILS
  function $reset() {
    user.value = null;
    isLoading.value = false;
    authError.value = null;

    if (import.meta.client) {
      localStorage.removeItem("nusift_pwa_profile");
      sessionStorage.clear();
      
      // ANCHOR COOKIE-CLEANUP
      const sessionStatus = useCookie("session_status");
      sessionStatus.value = null; // Explicitly nullify the indicator
    }
  }

  // ANCHOR ACTIONS
  const registerIdentity = async (emailPayload: string, passwordPayload: string) => {
    isLoading.value = true;
    authError.value = null;

    try {
      await $fetch("/api/auth/register", {
        method: "POST",
        body: { email: emailPayload, password: passwordPayload },
      });
      return true;
    } catch (error: any) {
      authError.value = error.data?.statusMessage || "Registration failed.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const loginIdentity = async (emailPayload: string, passwordPayload: string) => {
    isLoading.value = true;
    authError.value = null;

    try {
      const response: any = await $fetch("/api/auth/login", {
        method: "POST",
        body: { email: emailPayload, password: passwordPayload },
      });

      user.value = response.user;

      if (response.user) {
        agentStore.primaryRegion = response.user.primaryRegion || null;
        agentStore.topSources = response.user.topSources || [];
        agentStore.topInterests = (response.user.topInterests || []) as any;
      }

      if (!import.meta.server) {
        localStorage.setItem("nusift_pwa_profile", JSON.stringify(response.user));
      }
      return true;
    } catch (error: any) {
      authError.value = error.data?.statusMessage || "Authentication failure.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  /** ANCHOR OAUTH-HANDSHAKE
   * NEW SIGNATURE: Accepts raw token from identity provider.
   * Trust is deferred to the backend verification logic.
   */
  const oauthIdentity = async (rawToken: string, providerName: string) => {
    isLoading.value = true;
    authError.value = null;

    try {
      // Calls the unified, secure endpoint
      const response: any = await $fetch("/api/auth/oauth", {
        method: "POST",
        body: {
          token: rawToken,
          provider: providerName
        },
      });

      // Synchronize state with verified response
      user.value = response.user;

      if (response.user) {
        agentStore.primaryRegion = response.user.primaryRegion || null;
        agentStore.topSources = response.user.topSources || [];
        agentStore.topInterests = (response.user.topInterests || []) as any;
      }

      if (!import.meta.server) {
        localStorage.setItem("nusift_pwa_profile", JSON.stringify(response.user));
      }

      return true;
    } catch (error: any) {
      authError.value = error.data?.statusMessage || "OAuth handshake failed.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const logoutIdentity = async () => {
    try {
      // Ez meghívja a /api/auth/logout-ot, ami törli mindkét sütit a szerveren
      await $fetch("/api/auth/logout", { method: "POST" });
      $reset();
      return true;
    } catch (error) {
      console.error("Logout API failed", error);
      // Hiba esetén is kényszerítjük a lokális resetet
      $reset();
      return false;
    }
  };

  return {
    user,
    isLoading,
    authError,
    registerIdentity,
    loginIdentity,
    oauthIdentity,
    logoutIdentity,
    $reset,
  };
});