<template>
  <div class="w-full h-[250px] relative flex justify-center items-center">
    <div v-if="!chartData" class="text-on-surface-variant text-sm font-body animate-pulse">
      Processing AI node topology...
    </div>
    
    <!-- vue-chartjs generic Chart component -->
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

// Register the custom WordCloud controller alongside standard ChartJS plugins
ChartJS.register(WordCloudController, WordElement, Tooltip, Legend);

const props = defineProps<{
  nodes: Array<{ text: string; weight: number; opacity: number }>
}>();

// Sovereign-grade UI color palette
const sourceColors = [
  "#00E5FF", 
  "#fec931", 
  "#ff6b6b", 
  "#a855f7", 
  "#10b981", 
  "#3b82f6"
];

const chartData = computed(() => {
  if (!props.nodes || props.nodes.length === 0) return null;

  // Chart.js WordCloud expects arrays for labels and data
  const labels = props.nodes.map(n => n.text);
  
  // Scale the weights up (e.g., 2.5 -> 25) so the Chart.js font engine renders them clearly
  const data = props.nodes.map(n => n.weight * 10); 
  
  // Map colors dynamically based on the index
  const colors = props.nodes.map((_, index) => sourceColors[index % sourceColors.length]);

  return {
    labels: labels,
    datasets: [{
      label: 'AI Topic Weight',
      data: data,
      color: colors,
      fit: true // Ensures words don't overflow the canvas container
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
      backgroundColor: "rgba(17, 16, 16, 0.9)",
      titleColor: "#00E5FF",
      bodyColor: "#e2e2e2",
      borderColor: "rgba(255, 255, 255, 0.1)",
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    }
  },
  elements: {
    word: {
      fontFamily: 'system-ui, sans-serif',
      hoverColor: '#ffffff', // Highlights the word on mouseover
      rotationSteps: 2,      // Limits rotation to 0 and 90 degrees (horizontal/vertical)
      rotationRange: [0, 90]
    }
  }
};
</script>