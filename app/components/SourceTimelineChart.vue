<template>
  <div class="w-full h-full flex flex-col">
    <div class="flex items-center justify-between mb-3">
      <h4
        class="text-[10px] font-label font-bold text-on-surface-variant uppercase tracking-widest"
      >
        Scanned Articles Timeline
      </h4>
      <select
        v-model="selectedYear"
        class="bg-surface-container-highest text-on-surface border border-outline-variant/30 rounded-lg px-2 py-1 text-xs font-bold outline-none cursor-pointer"
      >
        <option v-for="year in availableYears" :key="year" :value="year">
          {{ year }}
        </option>
      </select>
    </div>

    <div class="relative w-full h-[150px] md:h-[120px]">
      <Line v-if="chartData" :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { Line } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

interface TimelineData {
  sourceName: string;
  data: number[];
}

const props = defineProps<{
  timelineData: TimelineData[];
  isLoading: boolean;
}>();

console.log("Received timelineData prop:", props.timelineData);

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([2026]);
const chartData = ref<any>(null);
const isLoading = ref(props.isLoading || false);

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: "index" as const,
    intersect: false,
  },
  plugins: {
    legend: {
      position: "bottom" as const,
      labels: {
        color: "rgba(255, 255, 255, 0.6)",
        usePointStyle: true,
        boxWidth: 8,
        font: { size: 11, family: "system-ui" },
      },
    },
    tooltip: {
      backgroundColor: "rgba(17, 16, 16, 0.9)",
      titleColor: "#00E5FF",
      bodyColor: "#e2e2e2",
      borderColor: "rgba(255, 255, 255, 0.1)",
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      grid: { color: "rgba(255, 255, 255, 0.05)" },
      ticks: { color: "rgba(255, 255, 255, 0.4)", font: { size: 10 } },
    },
    x: {
      grid: { display: false },
      ticks: { color: "rgba(255, 255, 255, 0.4)", font: { size: 10 } },
    },
  },
};

// Sovereign-grade UI color palette for dynamically added sources
const sourceColors = [
  "#00E5FF",
  "#fec931",
  "#ff6b6b",
  "#a855f7",
  "#10b981",
  "#3b82f6",
];

const fetchTimelineData = async () => {
  isLoading.value = true;
  try {
    // Note: If you want year-filtering, you can pass ?year=${selectedYear.value}
    // and update your Nuxt API endpoint to accept it via getQuery(event).
    

    if (props.timelineData && props.timelineData.length > 0) {
      const apiData = props.timelineData;

      chartData.value = {
        labels: [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ],
        datasets: apiData.map((source: any, index: number) => {
          const color = sourceColors[index % sourceColors.length];

          return {
            label: source.sourceName,
            data: source.data,
            borderColor: color,
            backgroundColor: `${color}1A`, // 10% opacity
            borderWidth: 2,
            pointBackgroundColor: color,
            pointBorderColor: "transparent",
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.4,
            fill: true,
          };
        }),
      };
    }
  } catch (error) {
    console.error("Failed to fetch timeline telemetry:", error);
  } finally {
    isLoading.value = false;
  }
};

watch(
  () => props.timelineData,
  () => {
    fetchTimelineData();
  },
  {
    deep: true,
    immediate: true,
  }
);
</script>
