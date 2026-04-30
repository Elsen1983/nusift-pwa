<template>
  <div
    class="glass-card rounded-2xl p-4 flex flex-col space-y-2 border-2 transition-all relative"
    :style="{
      borderColor: hasChanges ? '#fec931' : 'rgba(0, 229, 255, 0.1)',
      boxShadow: hasChanges
        ? '0 0 20px rgba(254, 201, 49, 0.2)'
        : '0 0 20px rgba(0, 229, 255, 0.15)',
    }"
  >
    <div class="flex justify-between items-start">
      <div class="flex items-center gap-3">
        <div
          class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center"
        >
          <span class="material-symbols-outlined text-[#00E5FF]">{{
            icon
          }}</span>
        </div>
        <h3 class="text-[#00E5FF] font-headline text-[16px] font-bold">
          {{ title }}
        </h3>
      </div>

      <button
        @click="$emit('deactivate', id)"
        class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-500/10 text-on-surface-variant hover:text-red-400 transition-colors"
        title="Deactivate Category"
      >
        <span class="material-symbols-outlined text-lg">close</span>
      </button>
    </div>

    <div class="space-y-2">
      <div class="space-y-2 relative">
        <div class="flex justify-between text-[10px] text-on-surface-variant uppercase font-label font-bold tracking-wider">
          <span>Priority Weight</span>
          <span :class="hasWeightChanged ? 'text-[#fec931]' : 'text-primary'">
            <template v-if="hasWeightChanged">
              {{ isLocallyNew ? 0 : originalWeight }}% 
              <span class="material-symbols-outlined text-[10px] align-middle font-bold px-1">arrow_forward</span> 
              {{ localWeight }}%
            </template>
            <template v-else>{{ originalWeight }}%</template>
          </span>
        </div>
        
        <div v-if="hasWeightChanged" class="absolute h-1 bg-[#fec931]/30 rounded-lg pointer-events-none" 
             :style="sliderDiffStyle"></div>
        
        <!-- Re-added @input for silent background syncing -->
        <input 
          type="range" min="0" max="100" 
          v-model.number="localWeight"
          @input="syncToParent"
          class="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-[#00E5FF] relative z-10" 
        />
      </div>

      <div class="relative pt-4">
        <span class="absolute top-0 right-0 text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">(PRO User Option)</span>
        <div class="relative">
          <!-- Re-added @input for silent background syncing -->
          <textarea 
            v-model="localPrompt"
            @input="syncToParent"
            maxlength="500"
            class="w-full bg-surface-container-highest/50 border-none rounded-xl p-2 text-sm font-body text-on-surface focus:ring-1 focus:ring-primary/40 min-h-[65px] resize-none"
            placeholder="Fine-tune agent focus..."
          ></textarea>
        </div>
        <div class="text-[10px] font-medium text-right pr-1 transition-colors duration-300" :class="localPrompt.length >= 500 ? 'text-red-400 font-bold' : 'text-on-surface-variant/60'">
          {{ localPrompt.length }}/500
        </div>
      </div>

      <p class="text-[12px] text-on-surface-variant italic opacity-70">AI-curated sub-nodes based on calibration.</p>

      <div v-if="chips && chips.length > 0" class="flex flex-wrap gap-2 transition-all duration-300">
        <span v-for="chip in visibleChips" :key="chip" class="bg-surface-container-highest text-primary-fixed-dim text-[#00E5FF] px-3 py-1 rounded-full text-[10px] font-medium border border-outline-variant/10">
          {{ chip }}
        </span>
        <button v-if="chips.length > 3" @click="isExpanded = !isExpanded" class="bg-surface-container-highest/50 border border-outline-variant/30 text-on-surface-variant px-3 py-1 rounded-full text-[10px] font-medium hover:bg-surface-container-high transition-colors">
          {{ isExpanded ? "Show less" : `+${chips.length - 3} more` }}
        </button>
      </div>

      <button
        v-if="hasChanges"
        @click="$emit('scroll-to-global')"
        class="w-full mt-4 py-2 bg-[#fec931] text-black text-on-tertiary-fixed font-bold rounded-lg text-xs uppercase tracking-widest hover:bg-[#fec931]/90 transition-all active:scale-[0.98]"
      >
        Save Changes
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";

const props = defineProps<{
  id: string;
  title: string;
  icon: string;
  initialWeight: number;
  initialPrompt: string;
  chips: string[];
  isNew?: boolean; // ÚJ: Érzékeljük, ha frissen aktivált
  globalSaveTick: number;
}>();

const emit = defineEmits(["update", "deactivate", "scroll-to-global"]); // ÚJ: deactivate regisztrálása

// Ha új, akkor 100%-ról indul a csúszka, egyébként a meglévő súlyról
const localWeight = ref(props.isNew ? 100 : props.initialWeight);
const localPrompt = ref(props.initialPrompt || "");
const isExpanded = ref(false);

// NEW: Static baseline states that do NOT react to the parent prop updates
const originalWeight = ref(props.initialWeight);
const originalPrompt = ref(props.initialPrompt || "");
const isLocallyNew = ref(props.isNew);

// Emit the data silently to the parent so it's ready for the global API call
const syncToParent = () => {
  emit("update", { id: props.id, weight: localWeight.value, prompt: localPrompt.value });
};

const hasWeightChanged = computed(() => {
  if (isLocallyNew.value) return true;
  return localWeight.value !== originalWeight.value;
});

const hasChanges = computed(() => {
  if (isLocallyNew.value) return true; 
  return localWeight.value !== originalWeight.value || localPrompt.value !== originalPrompt.value;
});

const visibleChips = computed(() => {
  if (!props.chips) return [];
  return isExpanded.value ? props.chips : props.chips.slice(0, 3);
});

const sliderDiffStyle = computed(() => {
  const baseWeight = isLocallyNew.value ? 0 : originalWeight.value; 
  const start = Math.min(localWeight.value, baseWeight);
  const end = Math.max(localWeight.value, baseWeight);
  return {
    left: `${start}%`, width: `${end - start}%`, top: "50%", transform: "translateY(-50%)",
  };
});

// NEW: Watch for the Global Save success signal to reset the card to a neutral state
watch(() => props.globalSaveTick, () => {
  originalWeight.value = localWeight.value;
  originalPrompt.value = localPrompt.value;
  isLocallyNew.value = false;
});
</script>

<style scoped>
.glass-card {
  background: rgba(17, 16, 16, 0.8);
  backdrop-filter: blur(12px);
}
.text-cursor {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  background-color: #00e5ff;
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
</style>
