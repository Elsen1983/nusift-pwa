<template>
  <div v-if="isVisible" class="fixed inset-0 z-[200] flex items-center justify-center px-4">
    <!-- REFACTORED: Removed hardcoded #131313 background -->
    <div class="absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-md"></div>
    
    <!-- REFACTORED: Replaced static rgba shadow with shadow-2xl -->
    <div class="relative bg-surface-container-low border border-outline-variant/20 w-full max-w-md rounded-3xl p-8 shadow-2xl">
      <div class="text-center mb-8">
        <div class="w-16 h-16 rounded-full bg-primary-container/10 flex items-center justify-center mx-auto mb-4 border border-primary-container/20">
          <span class="material-symbols-outlined text-primary-container text-3xl">language</span>
        </div>
        <!-- REFACTORED: text-white replaced with text-on-surface -->
        <h3 class="font-headline text-2xl font-bold text-on-surface mb-2 tracking-tight">
          {{ $t('auth.modal.language_selection_title') || 'Select Interface' }}
        </h3>
        <p class="text-on-surface-variant text-sm font-body">
          {{ $t('auth.modal.language_selection_subtitle') || 'Choose your preferred language protocol.' }}
        </p>
      </div>
      
      <div class="grid grid-cols-2 gap-3">
        <button 
          v-for="lang in availableLanguages" 
          :key="lang.code"
          @click="selectLanguage(lang)"
          :disabled="!lang.enabled"
          class="flex items-center gap-4 p-4 rounded-xl border transition-all text-left group"
          :class="[
            lang.enabled 
              ? 'border-outline-variant/30 bg-surface-container hover:bg-surface-container-high hover:border-primary-container/50 cursor-pointer' 
              : 'border-outline-variant/10 bg-surface-container-lowest opacity-50 cursor-not-allowed'
          ]"
        >
          <div class="flex shrink-0 shadow-sm group-hover:scale-110 transition-transform duration-300">
            <Icon :name="lang.icon" class="text-3xl" />
          </div>
          
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

/** 
 * ANCHOR LANGUAGE-MANIFEST
 * Using 'circle-flags' for cross-platform consistency.
 * Note: 'gb' is used for English (United Kingdom) protocol.
 */
const availableLanguages = [
  { code: 'en', name: 'English', icon: 'circle-flags:gb', enabled: true },
  { code: 'hu', name: 'Magyar', icon: 'circle-flags:hu', enabled: true },
  { code: 'fr', name: 'Français', icon: 'circle-flags:fr', enabled: false },
  { code: 'de', name: 'Deutsch', icon: 'circle-flags:de', enabled: false },
  { code: 'pl', name: 'Polski', icon: 'circle-flags:pl', enabled: false },
  { code: 'es', name: 'Español', icon: 'circle-flags:es', enabled: false },
];

onMounted(() => {
  const savedLang = localStorage.getItem('nusift_preferred_language');
  if (!savedLang) {
    isVisible.value = true;
  }
});

const selectLanguage = (lang: any) => {
  if (!lang.enabled) return;
  
  localStorage.setItem('nusift_preferred_language', lang.code);
  isVisible.value = false;
  emit('language-selected', lang.code);
};
</script>

<style scoped>
/* Optional: Ensure icons are perfectly crisp */
.iconify {
  display: block;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
}
</style>