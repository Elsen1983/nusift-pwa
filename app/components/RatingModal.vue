<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0" 
    enter-to-class="opacity-100" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100" 
    leave-to-class="opacity-0"
  >
    <div v-if="modelValue" class="fixed inset-0 z-[140] bg-black/80 backdrop-blur-sm flex items-center justify-center" @click.self="close">
      <div class="bg-[#353534] border border-[#40484a]/30 rounded-3xl p-6 max-w-[320px] w-[90%] shadow-[0_0_40px_rgba(0,229,255,0.08)] relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-b from-[#201f1f]/10 to-transparent pointer-events-none"></div>
        <div class="relative z-10 flex flex-col items-center text-center">
          <div class="w-14 h-14 bg-[#201f1f] rounded-full flex items-center justify-center mb-4 border border-[#40484a]/20 shadow-inner">
            <span class="material-symbols-outlined text-[28px] text-[#9ecfd8]" :style="{ fontVariationSettings: '\'FILL\' 1' }">tune</span>
          </div>
          <h3 class="font-headline text-[#e5e2e1] font-bold text-lg mb-2 leading-tight">Personal Rating</h3>
          <p class="text-xs font-body text-[#c0c8ca] leading-relaxed mb-6">Adjusting this rating will directly influence your AI agent's future curation logic for this topic.</p>
          
          <div class="w-full flex flex-col items-center mb-5">
            <span class="text-3xl font-headline font-bold text-[#00E5FF] mb-4">{{ localScore }}/10</span>
            <input 
              type="range" 
              min="0" max="10" step="1" 
              v-model.number="localScore"
              :disabled="isSaving"
              class="w-full h-2 bg-[#201f1f] rounded-lg appearance-none cursor-pointer accent-[#00E5FF]"
            >
            <div class="flex justify-between w-full text-[10px] text-[#c0c8ca]/50 font-label mt-2 font-bold px-1">
              <span>0</span><span>10</span>
            </div>
          </div>
          
          <div :class="['text-[#00E5FF] text-[10px] font-label font-bold tracking-wider uppercase h-4 mb-2 transition-opacity', isSaving ? 'opacity-100' : 'opacity-0']">
            Saving preference...
          </div>
          
          <div class="flex flex-col gap-3 w-full">
            <button 
              @click="confirm" 
              :disabled="!isChanged || isSaving" 
              class="w-full h-11 bg-gradient-to-r from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-bold rounded-xl text-xs uppercase tracking-wider transition-all active:scale-95 shadow-[0_4px_12px_rgba(0,229,255,0.2)] disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed disabled:active:scale-100"
            >
              Confirm Rating
            </button>
            <button @click="close" :disabled="isSaving" class="mt-1 text-[10px] font-label text-[#c0c8ca]/70 hover:text-[#e5e2e1] transition-colors py-2 uppercase tracking-wider font-bold">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';

const props = defineProps<{
  modelValue: boolean;
  initialScore: number;
}>();

const emit = defineEmits(['update:modelValue', 'confirm']);

const localScore = ref(0);
const isSaving = ref(false);

// Reset the slider to the article's actual score when the modal opens
watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    localScore.value = props.initialScore;
    isSaving.value = false;
  }
});

// Disable the confirm button if the user hasn't actually changed the rating
const isChanged = computed(() => localScore.value !== props.initialScore);

const close = () => {
  if (!isSaving.value) {
    emit('update:modelValue', false);
  }
};

const confirm = () => {
  isSaving.value = true;
  // Simulate the API delay before emitting the final data back to the dashboard
  setTimeout(() => {
    isSaving.value = false;
    emit('confirm', localScore.value);
    emit('update:modelValue', false);
  }, 1200);
};
</script>