<template>
  <div
    v-if="!isHydrated"
    class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#131313]"
  >
    <div class="delayed-spinner relative flex items-center justify-center">
      <div class="absolute w-12 h-12 border-2 border-primary-container/20 rounded-full"></div>
      <div class="absolute w-12 h-12 border-2 border-t-primary-container rounded-full animate-spin"></div>
    </div>
  </div>

  <div
    class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container transition-opacity duration-300"
    :class="isHydrated ? 'opacity-100' : 'opacity-0'"
  >
    <NuxtLayout>
      <VitePwaManifest />
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";

const authStore = useAuthStore();
const agentStore = useAgentStore();
const isHydrated = ref(false);
const { locale } = useI18n();
const route = useRoute();

const supportedLocales = new Set(["en", "hu", "fr", "de", "pl", "es"]);
const routeLocale = computed(() => {
  const match = route.path.match(/^\/(en|hu|fr|de|pl|es)(?=\/|$)/);
  return match?.[1] || null;
});

if (import.meta.client) {
  const savedLang = localStorage.getItem("nusift_preferred_language");
  const preferredLang = authStore.user?.preferredLanguage;
  const initialLang =
    (routeLocale.value && supportedLocales.has(routeLocale.value)
      ? routeLocale.value
      : null) ||
    (savedLang && supportedLocales.has(savedLang) ? savedLang : null) ||
    (preferredLang && supportedLocales.has(preferredLang)
      ? preferredLang
      : null) ||
    "en";

  if (initialLang) {
    locale.value = initialLang as typeof locale.value;
    localStorage.setItem("nusift_preferred_language", initialLang);
  }

  watch(
    locale,
    (newLocale) => {
      if (supportedLocales.has(newLocale)) {
        localStorage.setItem("nusift_preferred_language", newLocale);
      }
    },
    { immediate: true },
  );
}

const isChecking = ref(false);

const syncSessionStatus = async () => {
  try {
    const response = await fetch("/api/auth/user-validate", {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) return false;

    const sessionMeta = (await response.json()) as { valid: boolean; isAdmin?: boolean };
    if (authStore.user && sessionMeta?.isAdmin !== undefined) {
      authStore.user.isAdmin = sessionMeta.isAdmin;
    }
    return true;
  } catch {
    return false;
  }
};

const handleVisibilityChange = async () => {
  if (document.visibilityState === "visible" && !isChecking.value) {
    isChecking.value = true;
    try {
      const hasActiveSession = await syncSessionStatus();

      if (authStore.user !== null && !hasActiveSession) {
        if (typeof authStore.$reset === "function") authStore.$reset();
        else authStore.user = null;

        if (typeof agentStore.$reset === "function") agentStore.$reset();

        if (process.client) {
          sessionStorage.clear();
          localStorage.removeItem("nusift_pwa_profile");
        }

        window.location.href = "/auth";
        return;
      }

      if (
        authStore.user !== null &&
        hasActiveSession &&
        authStore.user.onboardingStep >= 3
      ) {
        // refresh hook reserved
      }
    } finally {
      isChecking.value = false;
    }
  }
};

onMounted(() => {
  if (import.meta.client && authStore.user) {
    const savedProfile = localStorage.getItem("nusift_pwa_profile");
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        if (parsed.id === authStore.user.id) {
          if (parsed.primaryRegion) agentStore.primaryRegion = parsed.primaryRegion;
          if (parsed.topSources) agentStore.topSources = parsed.topSources;
          if (parsed.topInterests) agentStore.topInterests = parsed.topInterests;

          authStore.user.primaryRegion = parsed.primaryRegion || null;
          authStore.user.topSources = parsed.topSources || [];
          authStore.user.topInterests = parsed.topInterests || [];
        }
      } catch {}
    }
  }

  if (import.meta.client) {
    void syncSessionStatus();
  }

  isHydrated.value = true;

  if (import.meta.client) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
});

onBeforeUnmount(() => {
  if (import.meta.client) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
});
</script>

<style>
html,
body {
  background-color: #131313;
  margin: 0;
  padding: 0;
}

.delayed-spinner {
  opacity: 0;
  animation: fadeIn 0.3s ease-in forwards;
  animation-delay: 0.2s;
}

@keyframes fadeIn {
  to {
    opacity: 1;
  }
}

.material-symbols-outlined {
  font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 24;
}

.glass-panel {
  background: rgba(28, 27, 27, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
