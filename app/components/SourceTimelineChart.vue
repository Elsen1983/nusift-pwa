<template>
  <div class="w-full h-full flex flex-col">
    <div class="flex items-center justify-between mb-3">
      <!-- RESTORED: text-semantic-ai brings back the #00E5FF cyan title -->
      <h4
        class="text-[10px] font-label font-bold text-semantic-ai uppercase tracking-widest"
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
import { ref, watch, computed, onMounted } from "vue";
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

// If using Nuxt Color Mode, this allows us to force chart re-renders on theme toggle
const colorMode = useColorMode(); 
const themeTrigger = ref(0);

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

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([2026]);
const chartData = ref<any>(null);
const isLoading = ref(props.isLoading || false);

/**
 * HELPER: Chart.js color parser bypass.
 * Reads the raw CSS variable (e.g., "0 229 255") from the DOM and formats it into
 * a standard `rgba(r, g, b, a)` string that Chart.js's canvas engine can safely render.
 */
const getCssColor = (varName: string, alpha: number = 1) => {
  if (typeof window === "undefined") return `rgba(0, 229, 255, ${alpha})`; // SSR Safety
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!val) return `rgba(0, 229, 255, ${alpha})`; // Fallback
  return `rgba(${val.split(/\s+/).join(", ")}, ${alpha})`;
};

const chartOptions = computed(() => {
  // We reference themeTrigger to force Vue to re-evaluate this computed property on theme change
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const trigger = themeTrigger.value; 

  const textColor = getCssColor("--color-on-surface-variant", 0.7);
  const gridColor = getCssColor("--color-outline-variant", 0.1);
  const tooltipBg = getCssColor("--color-surface-container-highest", 0.9);
  const tooltipTitle = getCssColor("--color-on-surface", 1);
  const tooltipBody = getCssColor("--color-on-surface-variant", 1);
  const tooltipBorder = getCssColor("--color-outline-variant", 0.3);

  return {
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
          color: textColor,
          usePointStyle: true,
          boxWidth: 8,
          font: { size: 11, family: "system-ui" },
        },
      },
      tooltip: {
        backgroundColor: tooltipBg,
        titleColor: tooltipTitle,
        bodyColor: tooltipBody,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: textColor, font: { size: 10 } },
      },
      x: {
        grid: { display: false },
        ticks: { color: textColor, font: { size: 10 } },
      },
    },
  };
});

const fetchTimelineData = async () => {
  isLoading.value = true;
  try {
    if (props.timelineData && props.timelineData.length > 0) {
      const apiData = props.timelineData;

      chartData.value = {
        labels: [
          "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ],
        datasets: apiData.map((source: any, index: number) => {
          // Dynamically read the correct color for the specific dataset
          const baseColor = getCssColor(`--color-chart-${(index % 6) + 1}`, 1);
          const bgColor = getCssColor(`--color-chart-${(index % 6) + 1}`, 0.1);

          return {
            label: source.sourceName,
            data: source.data,
            borderColor: baseColor,
            backgroundColor: bgColor,
            borderWidth: 2,
            pointBackgroundColor: baseColor,
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

// Re-render chart when Nuxt Color Mode changes
watch(() => colorMode.value, () => {
  setTimeout(() => {
    themeTrigger.value++;
    fetchTimelineData();
  }, 50); // Slight delay to ensure DOM has updated the CSS variables
});

watch(
  () => props.timelineData,
  () => {
    fetchTimelineData();
  },
  { deep: true, immediate: true }
);

onMounted(() => {
  fetchTimelineData();
});
</script>