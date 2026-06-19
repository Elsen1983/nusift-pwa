<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0" 
    enter-to-class="opacity-100" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100" 
    leave-to-class="opacity-0"
  >
    <div v-if="modelValue" class="fixed inset-0 z-[140] bg-surface-container-lowest/80 backdrop-blur-sm flex items-center justify-center" @click.self="close">
      <div class="bg-surface-container-highest border border-outline-variant/30 rounded-3xl p-6 max-w-[320px] w-[90%] shadow-xl shadow-primary-container/10 relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-b from-surface-container-lowest/20 to-transparent pointer-events-none"></div>
        <div class="relative z-10 flex flex-col items-center text-center">
          <div class="w-14 h-14 bg-surface-container-lowest rounded-full flex items-center justify-center mb-4 border border-outline-variant/20 shadow-inner">
            <span class="material-symbols-outlined text-[28px] text-primary-container" :style="{ fontVariationSettings: '\'FILL\' 1' }">tune</span>
          </div>
          <h3 class="font-headline text-on-surface font-bold text-lg mb-2 leading-tight">
            {{ t('personalRatingModal.title') }}
          </h3>
          <p class="text-xs font-body text-on-surface-variant leading-relaxed mb-6">
            {{ t('personalRatingModal.description') }}
          </p>
          
          <div class="w-full flex flex-col items-center mb-5">
            <span class="text-3xl font-headline font-bold text-primary-container mb-4">{{ localScore }}/10</span>
            <input 
              type="range" 
              min="0" max="10" step="1" 
              v-model.number="localScore"
              :disabled="isSaving"
              class="w-full h-2 bg-surface-container-lowest rounded-lg appearance-none cursor-pointer accent-primary-container"
            >
            <div class="flex justify-between w-full text-[10px] text-on-surface-variant/70 font-label mt-2 font-bold px-1">
              <span>0</span><span>10</span>
            </div>
          </div>
          
          <div :class="['text-primary-container text-[10px] font-label font-bold tracking-wider uppercase h-4 mb-2 transition-opacity', isSaving ? 'opacity-100' : 'opacity-0']">
            {{ t('personalRatingModal.saving') }}
          </div>
          
          <div class="flex flex-col gap-3 w-full">
            <button 
              @click="confirm" 
              :disabled="!isChanged || isSaving" 
              class="w-full h-11 bg-primary-container text-on-primary-container font-bold rounded-xl text-xs uppercase tracking-wider transition-all active:scale-95 shadow-md shadow-primary-container/20 disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed disabled:active:scale-100 hover:brightness-110"
            >
              {{ t('personalRatingModal.btn_confirm') }}
            </button>
            <button @click="close" :disabled="isSaving" class="mt-1 text-[10px] font-label text-on-surface-variant hover:text-on-surface transition-colors py-2 uppercase tracking-wider font-bold">
              {{ t('personalRatingModal.btn_cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{ modelValue: boolean; initialScore: number; }>();
const emit = defineEmits(['update:modelValue', 'confirm']);

const localScore = ref(0);
const isSaving = ref(false);

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    localScore.value = props.initialScore;
    isSaving.value = false;
  }
});

const isChanged = computed(() => localScore.value !== props.initialScore);

const close = () => { if (!isSaving.value) emit('update:modelValue', false); };
const confirm = () => {
  isSaving.value = true;
  setTimeout(() => {
    isSaving.value = false;
    emit('confirm', localScore.value);
    emit('update:modelValue', false);
  }, 1200);
};
</script>