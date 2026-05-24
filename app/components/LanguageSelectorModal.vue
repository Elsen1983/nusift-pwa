<template>
  <div v-if="isVisible" class="fixed inset-0 z-[200] flex items-center justify-center px-4">
    <div class="absolute inset-0 bg-[#131313]/95 backdrop-blur-md"></div>
    
    <div class="relative bg-surface-container-low border border-outline-variant/20 w-full max-w-md rounded-3xl p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
      <div class="text-center mb-8">
        <div class="w-16 h-16 rounded-full bg-primary-container/10 flex items-center justify-center mx-auto mb-4 border border-primary-container/20">
          <span class="material-symbols-outlined text-primary-container text-3xl">language</span>
        </div>
        <h3 class="font-headline text-2xl font-bold text-white mb-2 tracking-tight">Select Language</h3>
        <p class="text-on-surface-variant text-sm font-body">
          Choose your preferred language, please.
        </p>
      </div>
      
      <div class="grid grid-cols-2 gap-3">
        <button 
          v-for="lang in availableLanguages" 
          :key="lang.code"
          @click="selectLanguage(lang)"
          :disabled="!lang.enabled"
          class="flex items-center gap-3 p-4 rounded-xl border transition-all text-left"
          :class="[
            lang.enabled 
              ? 'border-outline-variant/30 bg-surface-container hover:bg-surface-container-high hover:border-primary/50 cursor-pointer' 
              : 'border-outline-variant/10 bg-surface-container-lowest opacity-50 cursor-not-allowed'
          ]"
        >
          <span class="text-2xl">{{ lang.flag }}</span>
          <span class="font-label text-sm font-bold text-on-surface tracking-wide">
            {{ lang.name }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

const emit = defineEmits(['language-selected']);
const isVisible = ref(false);

const availableLanguages = [
  { code: 'en', name: 'English', flag: '🇬🇧', enabled: true },
  { code: 'hu', name: 'Magyar', flag: '🇭🇺', enabled: true },
  { code: 'fr', name: 'Français', flag: '🇫🇷', enabled: false },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪', enabled: false },
  { code: 'pl', name: 'Polski', flag: '🇵🇱', enabled: false },
  { code: 'es', name: 'Español', flag: '🇪🇸', enabled: false },
];

onMounted(() => {
  // Check if a language has already been selected during a previous visit
  const savedLang = localStorage.getItem('nusift_preferred_language');
  if (!savedLang) {
    isVisible.value = true;
  }
});

const selectLanguage = (lang: any) => {
  if (!lang.enabled) return;
  
  // 1. Save to local storage for persistent gating
  localStorage.setItem('nusift_preferred_language', lang.code);
  
  // 2. Hide the modal
  isVisible.value = false;
  
  // 3. Emit the selection to the parent page (index.vue)
  emit('language-selected', lang.code);
};
</script>