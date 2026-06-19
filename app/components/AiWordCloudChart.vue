<template>
  <div class="w-full h-[250px] relative flex justify-center items-center">
    <div v-if="!chartData" class="text-on-surface-variant text-sm font-body animate-pulse">
      Processing AI node topology...
    </div>
    
    <Chart
      v-else
      type="wordCloud"
      :data="chartData"
      :options="chartOptions"
      class="w-full h-full drop-shadow-lg"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Chart as ChartJS, Tooltip, Legend } from 'chart.js';
import { Chart } from 'vue-chartjs';
import { WordCloudController, WordElement } from 'chartjs-chart-wordcloud';

ChartJS.register(WordCloudController, WordElement, Tooltip, Legend);

const props = defineProps<{
  nodes: Array<{ text: string; weight: number; opacity: number }>
}>();

const sourceColors = Array.from({length: 6}, (_, i) => `rgb(var(--color-chart-${i + 1}))`);

const chartData = computed(() => {
  if (!props.nodes || props.nodes.length === 0) return null;

  const labels = props.nodes.map(n => n.text);
  const data = props.nodes.map(n => n.weight * 10); 
  const colors = props.nodes.map((_, index) => sourceColors[index % sourceColors.length]);

  return {
    labels: labels,
    datasets: [{
      label: 'AI Topic Weight',
      data: data,
      color: colors,
      fit: true
    }]
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      display: false,
    },
    tooltip: {
      backgroundColor: "rgba(var(--color-surface-container-highest), 0.9)",
      titleColor: "rgb(var(--color-on-surface))",
      bodyColor: "rgb(var(--color-on-surface-variant))",
      borderColor: "rgba(var(--color-outline-variant), 0.3)",
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    }
  },
  elements: {
    word: {
      fontFamily: 'system-ui, sans-serif',
      hoverColor: 'rgb(var(--color-primary-container))',
      rotationSteps: 2,
      rotationRange: [0, 90]
    }
  }
};
</script>