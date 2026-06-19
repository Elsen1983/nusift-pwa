<template>
  <div
    class="bg-surface-container-low backdrop-blur-md rounded-2xl p-4 flex flex-col space-y-2 border-2 transition-all relative"
    :class="hasChanges ? 'border-warning shadow-[0_0_20px_rgb(var(--color-warning)/0.2)]' : 'border-primary-container/20 shadow-[0_0_20px_rgb(var(--color-primary-container)/0.15)]'"
  >
    <div class="flex justify-between items-start">
      <div class="flex items-center gap-3">
        <div
          class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center"
        >
          <span class="material-symbols-outlined text-primary-container">{{
            icon
          }}</span>
        </div>
        <h3 class="text-primary-container font-headline text-[16px] font-bold">
          {{ title }}
        </h3>
      </div>

      <button
        @click="$emit('deactivate', id)"
        class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors"
        :title="$t('activeCategoryCard.deactivate')"
      >
        <span class="material-symbols-outlined text-lg">close</span>
      </button>
    </div>

    <div class="space-y-2">
      <div class="space-y-2 relative max-w-[80%] md:max-w-full">
        <div class="flex justify-between text-[10px] text-on-surface-variant uppercase font-label font-bold tracking-wider">
          <span>{{ $t('activeCategoryCard.priority_weight') }}</span>
          <span :class="hasWeightChanged ? 'text-warning' : 'text-primary-container'">
            <template v-if="hasWeightChanged">
              {{ isLocallyNew ? 0 : originalWeight }}% 
              <span class="material-symbols-outlined text-[10px] align-middle font-bold px-1">arrow_forward</span> 
              {{ localWeight }}%
            </template>
            <template v-else>{{ originalWeight }}%</template>
          </span>
        </div>
        
        <div class="relative w-full h-2 flex items-center">
          <div 
            v-if="hasWeightChanged" 
            class="absolute h-1 bg-warning rounded-lg pointer-events-none z-0" 
            :style="sliderDiffStyle"
          ></div>
          
          <input 
            type="range" min="0" max="100" 
            v-model.number="localWeight"
            @input="syncToParent"
            class="w-full h-1 rounded-lg appearance-none cursor-pointer accent-primary-container relative z-10" 
            :style="{
              background: `linear-gradient(to right, rgb(var(--color-primary-container) / 0.4) ${localWeight}%, rgb(var(--color-outline-variant) / 0.2) ${localWeight}%)`
            }"
          />
        </div>
      </div>

      <div class="relative pt-4">
        <span 
          class="absolute top-0 right-0 text-[10px] font-bold uppercase tracking-widest transition-colors"
          :class="isPro ? 'text-on-surface-variant/40' : 'text-warning/60'"
        >
          {{ $t('activeCategoryCard.pro_option') }}
        </span>
        
        <div class="relative mt-2">
          <textarea 
            v-model="localPrompt"
            @input="syncToParent"
            maxlength="500"
            :disabled="!isPro"
            :class="[
              'w-full border-none rounded-xl p-2 text-sm font-body min-h-[65px] resize-none transition-all duration-300',
              isPro 
                ? 'bg-surface-container-highest/50 text-on-surface focus:ring-1 focus:ring-primary/40' 
                : 'bg-surface-container-lowest/80 text-on-surface-variant/30 opacity-60 cursor-not-allowed placeholder:text-on-surface-variant/20 shadow-inner'
            ]"
            :placeholder="isPro ? $t('activeCategoryCard.placeholder') : $t('activeCategoryCard.pro_option')"
          ></textarea>

          <div 
            v-if="!isPro" 
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <span class="material-symbols-outlined text-on-surface-variant/20 text-3xl">
              lock
            </span>
          </div>
        </div>

        <div 
          v-if="isPro"
          class="text-[10px] font-medium text-right pr-1 transition-colors duration-300" 
          :class="localPrompt.length >= 500 ? 'text-error font-bold' : 'text-on-surface-variant/60'"
        >
          {{ localPrompt.length }}/500
        </div>
      </div>

      <p class="text-[12px] text-on-surface-variant italic opacity-70">
        {{ $t('activeCategoryCard.sub_nodes_info') }}
      </p>

      <div v-if="chips && chips.length > 0" class="flex flex-wrap gap-2 transition-all duration-300">
        <span v-for="chip in visibleChips" :key="chip" class="bg-surface-container-highest text-primary-container px-3 py-1 rounded-full text-[10px] font-medium border border-outline-variant/10">
          {{ chip }}
        </span>
        <button v-if="chips.length > 3" @click="isExpanded = !isExpanded" class="bg-surface-container-highest/50 border border-outline-variant/30 text-on-surface-variant px-3 py-1 rounded-full text-[10px] font-medium hover:bg-surface-container-high transition-colors">
          {{ isExpanded ? $t('activeCategoryCard.show_less') : $t('activeCategoryCard.show_more', { count: chips.length - 3 }) }}
        </button>
      </div>

      <button
        v-if="hasChanges"
        @click="$emit('scroll-to-global')"
        class="w-full mt-4 py-2 bg-warning text-on-warning font-bold rounded-lg text-xs uppercase tracking-widest hover:brightness-110 transition-all active:scale-[0.98]"
      >
        {{ $t('activeCategoryCard.save_changes') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  id: string;
  title: string;
  icon: string;
  initialWeight: number;
  initialPrompt: string;
  chips: string[];
  isNew?: boolean; 
  userTier: string | undefined;
  globalSaveTick: number;
}>();

const emit = defineEmits(["update", "deactivate", "scroll-to-global"]); 

const localWeight = ref(props.isNew ? 100 : props.initialWeight);
const localPrompt = ref(props.initialPrompt || "");
const isExpanded = ref(false);

const originalWeight = ref(props.initialWeight);
const originalPrompt = ref(props.initialPrompt || "");
const isLocallyNew = ref(props.isNew);

const isPro = computed(() => props.userTier === 'PRO');

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

watch(() => props.globalSaveTick, () => {
  originalWeight.value = localWeight.value;
  originalPrompt.value = localPrompt.value;
  isLocallyNew.value = false;
});
</script>