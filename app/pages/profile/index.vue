<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-8 pb-20">
    
    <section class="flex items-center gap-4 px-2">
      <div class="w-16 h-16 rounded-full border border-primary-container/30 p-0.5 shrink-0 shadow-[0_0_15px_rgba(0,229,255,0.1)]">
        <img :src="userAvatar" class="w-full h-full object-cover rounded-full" />
      </div>
      <div class="min-w-0">
        <h2 class="font-headline text-2xl font-bold text-primary truncate">
          {{ authStore.user?.email?.split('@')[0] || 'Sovereign User' }}
        </h2>
        <p class="text-on-surface-variant text-sm font-label">{{ authStore.user?.email }}</p>
      </div>
    </section>

    <section>
      <div class="bg-surface-container-low rounded-3xl p-5 border border-outline-variant/10 flex items-center justify-between shadow-lg relative overflow-hidden">
        <div class="absolute -left-10 -top-10 w-40 h-40 bg-primary-container/5 blur-3xl rounded-full pointer-events-none"></div>

        <div class="relative z-10">
          <h3 class="text-on-surface font-headline font-bold mb-1">{{ $t('myProfile.quota.title') }}</h3>
          <p class="text-on-surface-variant text-[13px] font-label mb-4">
            <span class="text-primary-container font-bold">{{ activeCount }}</span> {{ $t('myProfile.quota.of') }} {{ limit }} {{ $t('myProfile.quota.sources') }}
          </p>
          <button class="px-4 py-2 bg-primary-container/10 text-primary-container border border-primary-container/30 rounded-xl text-[11px] font-bold uppercase tracking-wider hover:bg-primary-container/20 transition-colors">
            {{ $t('myProfile.quota.upgrade') }}
          </button>
        </div>
        
        <div class="relative w-20 h-20 flex items-center justify-center shrink-0">
          <svg class="transform -rotate-90 w-20 h-20">
            <circle cx="40" cy="40" r="32" stroke="currentColor" stroke-width="5" fill="transparent" class="text-surface-container-highest" />
            <circle cx="40" cy="40" r="32" stroke="currentColor" stroke-width="5" fill="transparent"
              :stroke-dasharray="201"
              :stroke-dashoffset="201 - (progressPercentage / 100) * 201"
              class="text-primary-container transition-all duration-1000 ease-out"
              stroke-linecap="round" />
          </svg>
          <span class="absolute text-primary text-sm font-headline font-bold">{{ progressPercentage }}%</span>
        </div>
      </div>
    </section>

    <section class="space-y-2">
      <h4 class="text-[10px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">{{ $t('myProfile.sections.account') }}</h4>
      <div class="bg-surface-container-low rounded-3xl p-2 border border-outline-variant/10 shadow-lg">
        
        <button class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">loyalty</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.subscription') }}</span>
          </div>
          <span class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors">chevron_right</span>
        </button>

        <button class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">credit_card</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.billing') }}</span>
          </div>
          <span class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors">chevron_right</span>
        </button>

        <button class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">manage_accounts</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.settings') }}</span>
          </div>
          <span class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors">chevron_right</span>
        </button>

      </div>
    </section>

    <section class="space-y-2">
      <h4 class="text-[10px] font-label font-bold text-on-surface-variant uppercase tracking-widest px-4">{{ $t('myProfile.sections.preference') }}</h4>
      <div class="bg-surface-container-low rounded-3xl p-2 border border-outline-variant/10 shadow-lg">
        
        <button class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">language</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.language') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-on-surface-variant text-[13px] font-label">English</span>
            <span class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors">chevron_right</span>
          </div>
        </button>

        <div class="w-full flex items-center justify-between p-3.5 rounded-2xl">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant">dark_mode</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.dark_mode') }}</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="isDarkMode" class="sr-only peer" disabled>
            <div class="w-11 h-6 bg-surface-container-highest peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-container"></div>
          </label>
        </div>

      </div>
    </section>

    <section class="space-y-2">
      <div class="bg-surface-container-low rounded-3xl p-2 border border-outline-variant/10 shadow-lg">
        <button class="w-full flex items-center justify-between p-3.5 hover:bg-surface-container-highest rounded-2xl transition-colors group">
          <div class="flex items-center gap-4 text-on-surface">
            <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container transition-colors">support_agent</span>
            <span class="font-body text-[15px] font-medium">{{ $t('myProfile.menu.help') }}</span>
          </div>
          <span class="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors">chevron_right</span>
        </button>
      </div>
    </section>

    <div class="flex items-center justify-between px-4 pt-4">
      <button @click="handleLogout" 
              class="flex items-center gap-2 text-error hover:text-red-400 transition-colors font-bold text-[15px]">
        <span class="material-symbols-outlined">logout</span>
        {{ $t('myProfile.logout') }}
      </button>
      <span class="text-on-surface-variant text-xs font-label">
        {{ $t('preloaderFirst.version') }}
      </span>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useAuthStore } from '~/stores/auth';
import defaultAvatar from '~/assets/images/default_avatar.png';

definePageMeta({
  layout: 'app-layout'
});

const authStore = useAuthStore();
const userAvatar = ref(defaultAvatar);

// Mock data for UI presentation. You will wire this up to your API similar to source-manager.vue
const activeCount = ref(4);
const limit = ref(5);
const isDarkMode = ref(true); // NuSift is dark-mode locked for now

const progressPercentage = computed(() => {
  if (limit.value <= 0) return 0;
  return Math.round((activeCount.value / limit.value) * 100);
});

const handleLogout = () => {
  const token = useCookie('auth_token');
  token.value = null;
  authStore.user = null;
  window.location.href = '/auth';
};
</script>