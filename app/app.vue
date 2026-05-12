<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container transition-opacity duration-300"
  :class="isHydrated ? 'opacity-100' : 'opacity-0'">
    <NuxtLayout>
      <VitePwaManifest />
    <NuxtPage /> 
    </NuxtLayout>
    
  </div>
</template>
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useAuthStore } from '~/stores/auth';
import { useAgentStore } from '~/stores/agent'; // Csak ha majd akarod frissíteni a feedet

const authStore = useAuthStore();
const agentStore = useAgentStore();
const isHydrated = ref(false);

// ANCHOR PAGE-VISIBILITY-GUARD
const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    
    // 1. Check the Shadow Cookie instead of the httpOnly token
    const sessionCookie = useCookie('session_status');
    const hasActiveSession = !!sessionCookie.value;
    
    // If Pinia says logged in, but the Shadow Cookie is gone (expired in background)
    if (authStore.user !== null && !hasActiveSession) {
      console.warn("Security Alert: Session expired in the background. Terminating access.");
      
      if (typeof authStore.$reset === "function") authStore.$reset();
      else authStore.user = null;
      
      if (typeof agentStore.$reset === "function") agentStore.$reset();

      if (process.client) {
        sessionStorage.clear();
        const sessionStatus = useCookie("session_status");
        sessionStatus.value = null;
      }

      window.location.href = '/auth';
      return; 
    }

    // 2. Data Refresh
    if (authStore.user !== null && hasActiveSession && authStore.user.onboardingStep >= 3) {
      console.log("Welcome back. Checking for daily horizon updates...");
      // agentStore.refreshFeedIfStale();
    }
  }
};

onMounted(() => {
  // ANCHOR CLIENT-SIDE HYDRATION
  // Restore rich agent data from localStorage before lifting the Hydration Cloak
  if (import.meta.client && authStore.user) {
    const savedProfile = localStorage.getItem("nusift_pwa_profile");
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        // Security check: Only hydrate if the IDs match
        if (parsed.id === authStore.user.id) {
          // 1. Restore Agent Store
          if (parsed.primaryRegion) agentStore.primaryRegion = parsed.primaryRegion;
          if (parsed.topSources) agentStore.topSources = parsed.topSources;
          if (parsed.topInterests) agentStore.topInterests = parsed.topInterests;
          
          // 2. Sync Auth Store
          authStore.user.primaryRegion = parsed.primaryRegion || null;
          authStore.user.topSources = parsed.topSources || [];
          authStore.user.topInterests = parsed.topInterests || [];
        }
      } catch (error) {
        console.warn("Profile hydration failed:", error);
      }
    }
  }

  isHydrated.value = true;

  if (import.meta.client) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
});

onBeforeUnmount(() => {
  // Memory leak elkerülése: mindig takarítjuk az eseménykezelőt, ha a komponens megsemmisül
  if (import.meta.client) {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
});
</script>
<style>
/* ANCHOR: GLOBAL-STYLES
   Universal CSS rules that govern core UI components and utility behaviors. */

/* ANCHOR: ICONOGRAPHY-CONFIG
   Material Symbols base configuration. Ensures consistent weight and optical size. */
.material-symbols-outlined {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* ANCHOR: GLASSMORPHISM-UTILITY
   Standard glass panel effect for overlays, drawers, and floating cards. 
   Uses backdrop-blur for the high-end neural aesthetic. */
.glass-panel {
  background: rgba(28, 27, 27, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ANCHOR: SCROLLBAR-MANAGEMENT
   Utility class to hide scrollbars while maintaining functionality. 
   Critical for clean, app-like mobile interfaces. */
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>