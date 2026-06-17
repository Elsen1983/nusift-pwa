<template>
  <div class="w-full flex flex-col gap-2 py-1 min-h-[150px] justify-center">
    <div v-if="!nodes || nodes.length === 0" class="text-on-surface-variant text-sm font-body text-center animate-pulse">
      No AI nodes detected for this category.
    </div>
    
    <div
      v-else
      v-for="(node, index) in sortedNodes"
      :key="index"
      class="relative w-full h-9 bg-surface-container-highest/50 rounded-lg overflow-hidden group"
    >
      <div
        class="absolute top-0 left-0 h-full transition-all duration-1000 ease-out opacity-90 group-hover:opacity-100"
        :style="{ 
          width: `${(node.value / maxValue) * 100}%`, 
          backgroundColor: getBarColor(index) 
        }"
      ></div>

      <div class="absolute inset-0 flex items-center justify-between px-2 z-10 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
        <span class="text-[13px] font-headline font-bold text-white tracking-wide truncate">
          {{ node.text }}
        </span>
        <span class="text-[11px] font-label font-bold text-white/90 bg-black/20 px-2 py-0.5 rounded-md backdrop-blur-sm">
          {{ node.value.toFixed(1) }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  nodes: Array<{ text: string; value: number }>
}>();

// Sovereign UI Colors for the bars
const sourceColors = [
  "#00E5FF", 
  "#fec931", 
  "#ff6b6b", 
  "#a855f7", 
  "#10b981", 
  "#3b82f6"
];

// Sort nodes by weight (highest first) for a standard top-down bar chart look
const sortedNodes = computed(() => {
  if (!props.nodes) return [];
  return [...props.nodes].sort((a, b) => b.value - a.value);
});

// Find the maximum value to calculate percentage widths dynamically
const maxValue = computed(() => {
  if (!sortedNodes.value.length) return 1;
  return Math.max(...sortedNodes.value.map(n => n.value));
});

const getBarColor = (index: number) => {
  return sourceColors[index % sourceColors.length];
};
</script>