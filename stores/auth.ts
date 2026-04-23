// stores/auth.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAuthStore = defineStore('auth', () => {
  // ANCHOR STATE
  // Itt tároljuk az aktív felhasználó adatait. Ha null, akkor nincs bejelentkezve.
  const user = ref<{ id: string; email: string; createdAt: string } | null>(null);
  
  // A hálózati kérések állapotát is itt kezeljük globálisan
  const isLoading = ref(false);
  const authError = ref<string | null>(null);

  // ANCHOR ACTIONS
  const registerIdentity = async (emailPayload: string, passwordPayload: string) => {
    isLoading.value = true;
    authError.value = null;

    try {
      // API hívás a saját Nitro szerverünkhöz
      const response = await $fetch('/api/auth/register', {
        method: 'POST',
        body: {
          email: emailPayload,
          password: passwordPayload
        }
      });

      // Sikeres válasz esetén elmentjük a usert a globális memóriába
      user.value = response.user;
      return true; // Sikeres futás jelzése a komponens felé

    } catch (error: any) {
      // Hibakezelés (pl. 409 Conflict - Email már létezik)
      console.error('Store: Registration failed', error);
      authError.value = error.data?.statusMessage || 'System Error. Could not forge identity.';
      return false; // Sikertelen futás
    } finally {
      isLoading.value = false;
    }
  };

  // Később ide jön majd a login() és a logout() is

  return {
    user,
    isLoading,
    authError,
    registerIdentity
  };
});