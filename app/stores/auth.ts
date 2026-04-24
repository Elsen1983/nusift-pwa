// stores/auth.ts
import { defineStore } from "pinia";
import { ref } from "vue";

export const useAuthStore = defineStore("auth", () => {
  // ANCHOR STATE
  // Itt tároljuk az aktív felhasználó adatait. Ha null, akkor nincs bejelentkezve.
  const user = ref<{ id: string; email: string; createdAt: string; onboardingStep: number } | null>(null);

  // PWA OFFLINE FALLBACK
  if (!import.meta.server && !user.value) {
    const offlineProfile = localStorage.getItem('nusift_pwa_profile');
    if (offlineProfile) {
      try {
        user.value = JSON.parse(offlineProfile);
      } catch (e) {
        console.error('Hibás PWA profil a cache-ben');
      }
    }
  }

  // A hálózati kérések állapotát is itt kezeljük globálisan
  const isLoading = ref(false);
  const authError = ref<string | null>(null);

  // ANCHOR ACTIONS
  const registerIdentity = async (
    emailPayload: string,
    passwordPayload: string,
  ) => {
    isLoading.value = true;
    authError.value = null;

    try {
      // API hívás a saját Nitro szerverünkhöz
      const response = await $fetch("/api/auth/register", {
        method: "POST",
        body: {
          email: emailPayload,
          password: passwordPayload,
        },
      });

      // Sikeres válasz esetén elmentjük a usert a globális memóriába
      user.value = response.user;

      if (!import.meta.server) {
        localStorage.setItem('nusift_pwa_profile', JSON.stringify(response.user));
      }

      return true; // Sikeres futás jelzése a komponens felé
    } catch (error: any) {
      // Hibakezelés (pl. 409 Conflict - Email már létezik)
      console.error("Store: Registration failed", error);
      authError.value =
        error.data?.statusMessage || "System Error. Could not forge identity.";
      return false; // Sikertelen futás
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

      // Store the user data in memory
      user.value = response.user;

      // PWA OFFLINE MENTÉS
      if (!import.meta.server) {
        localStorage.setItem('nusift_pwa_profile', JSON.stringify(response.user));
      }

      return true;
    } catch (error: any) {
      console.error("Store: Login failed", error);
      authError.value =
        error.data?.statusMessage ||
        "Authentication failure. Check credentials.";
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const logoutIdentity = async () => {
    try {
      await $fetch("/api/auth/logout", { method: "POST" });
      user.value = null; // Töröljük a memóriát is

      // PWA OFFLINE DELETE
      if (!import.meta.server) {
        localStorage.removeItem('nusift_pwa_profile');
      }

      return true;
    } catch (error) {
      console.error("Logout failed", error);
      return false;
    }
  };

  return {
    user,
    isLoading,
    authError,
    registerIdentity,
    loginIdentity,
    logoutIdentity
  };
});
