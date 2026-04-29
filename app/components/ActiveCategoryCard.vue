<template>
  <div 
    class="glass-card rounded-2xl p-4 flex flex-col space-y-2 border-2 transition-all relative" 
    :style="{ 
      borderColor: hasChanges ? '#fec931' : 'rgba(0, 229, 255, 0.1)', 
      boxShadow: hasChanges ? '0 0 20px rgba(254, 201, 49, 0.2)' : '0 0 20px rgba(0, 229, 255, 0.15)' 
    }"
  >
    <div class="flex justify-between items-start">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <span class="material-symbols-outlined text-[#00E5FF]">{{ icon }}</span>
        </div>
        <h3 class="text-[#00E5FF] font-headline text-[16px] font-bold">{{ title }}</h3>
      </div>
    </div>
    
    <div class="space-y-2">
      <div class="space-y-2 relative">
        <div class="flex justify-between text-[10px] text-on-surface-variant uppercase font-label font-bold tracking-wider">
          <span>Priority Weight</span>
          <span :class="hasChanges ? 'text-[#fec931]' : 'text-primary'">
            <template v-if="hasChanges">{{ localWeight }}% <- </template>
            {{ initialWeight }}%
          </span>
        </div>
        <div v-if="hasChanges" class="absolute h-1 bg-[#fec931]/30 rounded-lg pointer-events-none" 
             :style="sliderDiffStyle"></div>
        
        <input 
          type="range" min="0" max="100" 
          v-model.number="localWeight"
          class="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-[#00E5FF] relative z-10" 
        />
      </div>

      <div class="relative pt-4">
        <span class="absolute top-0 right-0 text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">(PRO User Option)</span>
        <div class="relative">
          <textarea 
            v-model="localPrompt"
            class="w-full bg-surface-container-highest/50 border-none rounded-xl p-4 text-sm font-body text-on-surface focus:ring-1 focus:ring-primary/40 min-h-[50px] resize-none"
            placeholder="Fine-tune agent focus..."
          ></textarea>
          <span v-if="localPrompt.length > 0 && !hasChanges" class="text-cursor absolute bottom-4 right-4 opacity-0"></span>
        </div>
        <div class="text-[10px] text-on-surface-variant/60 font-medium text-right pr-1">
          {{ localPrompt.length }}/500
        </div>
      </div>
      
      <p class="text-[12px] text-on-surface-variant italic opacity-70">AI-curated sub-nodes based on calibration.</p>
      
      <div class="flex flex-wrap gap-2 transition-all duration-300">
        <span v-for="chip in visibleChips" :key="chip" class="bg-surface-container-highest text-primary-fixed-dim text-[#00E5FF] px-3 py-1 rounded-full text-[10px] font-medium border border-outline-variant/10">
          {{ chip }}
        </span>
        <button v-if="chips.length > 3" @click="isExpanded = !isExpanded" 
                class="bg-surface-container-highest/50 border border-outline-variant/30 text-on-surface-variant px-3 py-1 rounded-full text-[10px] font-medium hover:bg-surface-container-high transition-colors">
          {{ isExpanded ? 'Show less' : `+${chips.length - 3} more` }}
        </button>
      </div>

      <button 
        v-if="hasChanges"
        @click="saveLocal"
        class="w-full mt-4 py-2 bg-[#fec931] text-black text-on-tertiary-fixed font-bold rounded-lg text-xs uppercase tracking-widest hover:bg-[#fec931]/90 transition-all active:scale-[0.98]"
      >
        Save Changes
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  id: string; title: string; icon: string; 
  initialWeight: number; initialPrompt: string; chips: string[];
}>();

const emit = defineEmits(['update']);

const localWeight = ref(props.initialWeight);
const localPrompt = ref(props.initialPrompt);
const isExpanded = ref(false);

const hasChanges = computed(() => {
  return localWeight.value !== props.initialWeight || localPrompt.value !== props.initialPrompt;
});

const visibleChips = computed(() => isExpanded.value ? props.chips : props.chips.slice(0, 3));

const sliderDiffStyle = computed(() => {
  const start = Math.min(localWeight.value, props.initialWeight);
  const end = Math.max(localWeight.value, props.initialWeight);
  return {
    left: `${start}%`,
    width: `${end - start}%`,
    top: '50%',
    transform: 'translateY(-50%)'
  };
});

const saveLocal = () => {
  emit('update', { id: props.id, weight: localWeight.value, prompt: localPrompt.value });
};
</script>

<style scoped>
.glass-card { background: rgba(17, 16, 16, 0.8); backdrop-filter: blur(12px); }
.text-cursor {
  display: inline-block; width: 2px; height: 1.2em; background-color: #00E5FF;
  animation: blink 1s step-end infinite;
}
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
</style>