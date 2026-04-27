<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-8">
    
    <section class="bg-surface-container rounded-3xl p-6 border border-outline-variant/10 flex items-center gap-5">
      <div class="w-20 h-20 rounded-full border-2 border-primary-container p-1 shrink-0 shadow-[0_0_15px_rgba(0,229,255,0.2)]">
        <img :src="userAvatar" class="w-full h-full object-cover rounded-full" />
      </div>
      <div class="min-w-0">
        <h2 class="font-headline text-2xl font-bold text-primary truncate">
          {{ authStore.user?.email.split('@')[0] }}
        </h2>
        <p class="text-on-surface-variant text-xs font-label mb-2">{{ authStore.user?.email }}</p>
        <div class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-primary-container/10 border border-primary-container/20 rounded-md">
          <span class="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse"></span>
          <span class="text-[10px] font-bold text-primary-container uppercase tracking-widest">
            Agent {{ agentStore.agentVersion }}
          </span>
        </div>
      </div>
    </section>

    <div class="grid grid-cols-2 gap-3">
      <div v-for="stat in agentStore.stats" :key="stat.label" 
           class="bg-surface-container-high rounded-2xl p-4 border border-outline-variant/5">
        <span class="material-symbols-outlined text-primary-container text-xl mb-1">{{ stat.icon }}</span>
        <div class="text-xl font-headline font-bold text-primary">{{ stat.value }}</div>
        <div class="text-[9px] font-label text-on-surface-variant uppercase tracking-wider">{{ stat.label }}</div>
      </div>
    </div>

    <section class="bg-surface-container rounded-3xl p-6 border border-outline-variant/10">
      <div class="flex justify-between items-center mb-6">
        <h3 class="font-headline text-sm font-bold text-primary uppercase tracking-widest">Intelligence Profile</h3>
        <NuxtLink to="/interest-calibration" class="text-primary-container text-[10px] font-bold uppercase hover:underline">
          Adjust Agent
        </NuxtLink>
      </div>
      <div class="space-y-5">
        <div v-for="pref in agentStore.topPreferences" :key="pref.id" class="group">
          <div class="flex justify-between text-xs font-label mb-2">
            <span class="text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-sm opacity-50">{{ pref.icon }}</span>
              {{ pref.name }}
            </span>
            <span class="text-primary-container font-bold">{{ pref.weight }}%</span>
          </div>
          <div class="h-1 bg-surface-container-highest rounded-full overflow-hidden">
            <div class="h-full bg-primary-container transition-all duration-1000" 
                 :style="{ width: pref.weight + '%' }"></div>
          </div>
        </div>
      </div>
    </section>

    <button @click="handleLogout" 
            class="w-full py-4 rounded-2xl bg-error/5 text-error font-bold flex items-center justify-center gap-3 hover:bg-error/10 transition-all border border-error/20 group">
      <span class="material-symbols-outlined group-hover:rotate-180 transition-transform duration-500">logout</span>
      TERMINATE SECURE SESSION
    </button>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import { useAgentStore } from '~/stores/agent';

// ANCHOR LAYOUT-DEFINITION
definePageMeta({
  layout: 'app-layout' // Ennek egyeznie kell a layouts/app-layout.vue fájlnévvel
});

const authStore = useAuthStore();
const agentStore = useAgentStore();
const userAvatar = "https://lh3.googleusercontent.com/a/default-user";

/**
 * ANCHOR SECURE-LOGOUT
 * Megszakít minden folyamatot és visszadob az auth oldalra hard-reload-al.
 */
const handleLogout = () => {
  const token = useCookie('auth_token');
  
  // State tisztítása
  token.value = null;
  authStore.user = null;
  
  // Security Red Flag fix: Hard redirection
  window.location.href = '/auth';
};
</script>