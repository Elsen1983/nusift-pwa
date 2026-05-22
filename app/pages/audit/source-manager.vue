<template>
  <div class="relative min-h-screen">
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-neon-cyan/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    <div
      class="fixed bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-secondary-container/10 blur-[140px] rounded-full -z-10 pointer-events-none"
    ></div>

    <main class="pt-5 pb-12 px-4 max-w-5xl mx-auto space-y-4 relative z-10">
      <section class="mb-2 px-3">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-2"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Source Network Manager</span
          >
        </div>
        <h2
          class="font-lg text-3xl md:text-5xl font-bold text-primary leading-tight tracking-tight mb-4 text-white"
        >
          Control Your Data Streams
        </h2>
        <p
          class="text-on-surface-variant text-[12px] max-w-2xl leading-relaxed font-body"
        >
          Curate the exact nodes and feeds your AI Agent monitors. Add new
          sources, manage your tier quotas, and suspend or remove streams to
          maintain a clean, sovereign intelligence feed.
        </p>
      </section>

      <section class="space-y-2 px-3">
        <div
          class="flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <h2
            class="font-headline text-lg font-semibold tracking-tight text-on-surface flex items-center gap-2"
          >
            Active Nodes: {{ activeSources.length }}/{{ quota.limit }}
            <span class="text-on-surface-variant text-sm font-normal"
              >({{ quota.tier === "PRO" ? "Pro" : "Free" }} Tier)</span
            >
          </h2>

          <button
            v-if="quota.tier === 'FREE'"
            class="bg-surface-container-high hover:bg-surface-container-highest transition-colors px-4 py-1 rounded-full flex items-center gap-2 group outline outline-1 outline-outline-variant/30 border border-outline-variant/50 hover:border-neon-cyan/70 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              class="font-label text-[12px] text-neon-cyan group-hover:drop-shadow-[0_0_8px_rgba(0,229,255,0.8)] transition-all"
              >Upgrade to Pro (15 max)? Click here.</span
            >
            <span class="material-symbols-outlined text-neon-cyan text-sm"
              >rocket_launch</span
            >
          </button>
        </div>

        <div
          class="h-2 w-full bg-surface-container-low rounded-full overflow-hidden"
        >
          <div
            class="h-full bg-gradient-to-r from-neon-cyan to-[#9cf0ff] rounded-full relative transition-all duration-500"
            :style="{ width: `${progressPercentage}%` }"
          >
            <div class="absolute inset-0 bg-white/20 animate-pulse"></div>
          </div>
        </div>
      </section>

      <section
        class="bg-surface-container rounded-2xl p-3 shadow-[0_0_24px_0_rgba(0,229,255,0.08)] outline outline-1 outline-outline-variant/15 relative overflow-hidden mx-2"
      >
        <div class="relative z-10 space-y-4">
          <div class="relative group">
            <label
              for="source-url-input"
              class="block text-[13px] font-label uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
            >
              Ingestion Hub
            </label>
            <div
              class="bg-surface-container-low p-1 rounded-xl transition-all duration-300 focus-within:shadow-[0_0_20px_rgba(0,229,255,0.05)]"
            >
              <input
                id="source-url-input"
                v-model="newSourceUrl"
                @keyup.enter="addNewSource"
                class="w-full bg-surface-container-highest border-none rounded-lg text-on-surface placeholder:text-outline/50 focus:ring-1 focus:ring-neon-cyan/30 font-body h-[52px] text-[14px] font-bold px-4 disabled:opacity-50 outline-none"
                placeholder="Enter source URL (e.g. bloomberg.com/tech)..."
                type="text"
                :disabled="isProcessing"
              />
            </div>
            <p
              v-if="newSourceUrl && !isValidUrl"
              class="text-error text-[12px] font-label mt-1 ml-1 leading-tight text-red-500"
            >
              Please enter a valid domain format.
            </p>
          </div>

          <div class="flex justify-end mr-1">
            <button
              @click="addNewSource"
              :disabled="!newSourceUrl || !isValidUrl || isProcessing"
              class="bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-bold px-6 rounded-xl flex items-center gap-1 hover:scale-[1.02] active:scale-95 transition-all shadow-[0_8px_20px_rgba(0,229,255,0.15)] group py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span
                v-if="!isProcessing"
                class="material-symbols-outlined text-xl"
                >add</span
              >
              <span
                v-else
                class="animate-spin h-5 w-5 border-2 border-[#131313] border-t-transparent rounded-full"
              ></span>
              <span class="text-[16px]">Add New Source</span>
            </button>
          </div>
        </div>

        <Transition name="fade">
          <div
            v-if="toast.show"
            :class="[
              'mt-5 flex items-center gap-2 text-sm font-label px-4 py-2 rounded-lg inline-flex outline outline-1 transition-all relative z-10',
              toast.type === 'warning'
                ? 'text-tertiary-fixed bg-tertiary-fixed/10 outline-tertiary-fixed/20'
                : toast.type === 'error'
                  ? 'text-error bg-error/10 outline-error/20'
                  : 'text-neon-cyan bg-neon-cyan/10 outline-neon-cyan/20',
            ]"
          >
            <span class="material-symbols-outlined text-sm">
              {{
                toast.type === "warning"
                  ? "info"
                  : toast.type === "error"
                    ? "error"
                    : "check_circle"
              }}
            </span>
            {{ toast.message }}
          </div>
        </Transition>
      </section>

      <section class="space-y-6 px-3">
        <h2
          class="font-headline text-lg font-semibold tracking-tight text-on-surface flex items-center gap-2"
        >
          Active Data Streams
        </h2>

        <div class="grid grid-cols-1 gap-4" v-if="activeSources.length > 0">
          <div
            v-for="source in activeSources"
            :key="source.id"
            class="bg-surface-container-low hover:bg-surface-container transition-colors rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 outline outline-1 outline-outline-variant/15 group"
          >
            <div class="flex-grow space-y-1">
              <h4 class="font-body font-bold text-on-surface text-lg">
                {{ source.name || getDomain(source.url) }}
              </h4>
              <p
                class="font-label text-xs text-on-surface-variant flex items-center gap-2"
                v-if="getPath(source.url)"
              >
                {{ getPath(source.url) }}
              </p>

              <div class="flex gap-2 mt-3">
                <span
                  v-for="(badge, index) in getBadges(source.validationStatus)"
                  :key="index"
                  :class="[
                    'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1',
                    badge.classes,
                  ]"
                >
                  <span
                    class="material-symbols-outlined text-[12px]"
                    :class="badge.iconClasses"
                    >{{ badge.icon }}</span
                  >
                  {{ badge.label }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                @click="toggleSourceState(source.id, false)"
                :disabled="isProcessing"
                class="p-2 text-on-surface-variant hover:text-on-surface bg-surface-container-highest rounded-full transition-colors flex items-center justify-center outline outline-1 outline-transparent hover:outline-outline-variant/30 disabled:opacity-50"
                title="Suspend Stream"
              >
                <span
                  class="material-symbols-outlined text-sm"
                  :style="{ fontVariationSettings: `'FILL' 1` }"
                >
                  pause
                </span>
              </button>
              <button
                @click="deleteSource(source.id)"
                :disabled="isProcessing"
                class="p-2 text-error/70 hover:text-error hover:bg-error/10 rounded-full transition-colors flex items-center justify-center disabled:opacity-50"
                title="Delete Source"
              >
                <span class="material-symbols-outlined text-sm">delete</span>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-8 text-on-surface-variant font-body">
          No active data streams. Add a source above to begin routing data.
        </div>
      </section>

      <section
        class="space-y-6 px-3 opacity-80 hover:opacity-100 transition-opacity"
      >
        <h3
          class="font-headline text-xl font-medium text-on-surface-variant flex items-center gap-2"
        >
          <span class="material-symbols-outlined text-xl">inventory_2</span>
          Suspended Zone
        </h3>

        <div class="grid grid-cols-1 gap-4" v-if="suspendedSources.length > 0">
          <div
            v-for="source in suspendedSources"
            :key="source.id"
            class="bg-surface-container-lowest rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 outline outline-1 outline-outline-variant/20 border-l-2 border-l-outline-variant"
          >
            <div
              class="flex-grow space-y-1 opacity-60 grayscale group-hover:grayscale-0 transition-all"
            >
              <h4 class="font-body font-bold text-on-surface-variant text-lg">
                {{ source.name || getDomain(source.url) }}
              </h4>
              <p
                class="font-label text-xs text-outline flex items-center gap-2"
                v-if="getPath(source.url)"
              >
                {{ getPath(source.url) }}
              </p>
              <div class="flex gap-2 mt-3">
                <span
                  v-for="(badge, index) in getBadges(source.validationStatus)"
                  :key="index"
                  :class="[
                    'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1',
                    badge.classes,
                  ]"
                >
                  <span
                    class="material-symbols-outlined text-[12px]"
                    :class="badge.iconClasses"
                    >{{ badge.icon }}</span
                  >
                  {{ badge.label }}
                </span>
              </div>
              <button
                v-if="
                  source.validationStatus === 'FAILED' ||
                  source.validationStatus === 'NO_RSS_FOUND'
                "
                @click="triggerReDiscovery(source.url)"
                :disabled="isProcessing"
                class="mt-4 flex items-center gap-1 text-[10px] font-label tracking-wider text-neon-cyan/70 hover:text-neon-cyan transition-colors uppercase outline outline-1 outline-neon-cyan/30 hover:outline-neon-cyan/80 px-2 py-1 rounded-md w-max disabled:opacity-50"
              >
                <span
                  class="material-symbols-outlined text-[12px]"
                  :class="{ 'animate-spin': isProcessing }"
                  >sync</span
                >
                Trigger Re-Discovery
              </button>
            </div>

            <div class="flex items-center gap-2 relative group">
              <div
                v-if="isQuotaFull"
                class="absolute bottom-full right-0 mb-2 w-max bg-surface-bright text-on-surface text-[10px] font-label px-3 py-2 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20"
              >
                Suspend an active source to free up space.
              </div>

              <button
                @click="toggleSourceState(source.id, true)"
                :disabled="isQuotaFull || isProcessing"
                class="p-2 text-on-surface-variant bg-surface-container-low rounded-full flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-neon-cyan/20 hover:text-neon-cyan"
              >
                <span
                  class="material-symbols-outlined text-sm"
                  :style="{ fontVariationSettings: `'FILL' 1` }"
                  >play_arrow</span
                >
              </button>

              <button
                @click="deleteSource(source.id)"
                :disabled="isProcessing"
                class="p-2 text-error/50 hover:text-error hover:bg-error/10 rounded-full transition-colors flex items-center justify-center z-10 relative cursor-pointer disabled:opacity-30"
              >
                <span class="material-symbols-outlined text-sm">delete</span>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-4 text-outline font-body text-sm">
          Your suspended zone is empty.
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

definePageMeta({ layout: "app-layout" });

// --- STATE ---
const newSourceUrl = ref("");
const isProcessing = ref(false);
const toast = ref({ show: false, message: "", type: "success" });

const sources = ref<any[]>([]);
const quota = ref({
  tier: "FREE",
  limit: 5,
  activeCount: 0,
  availableSlots: 5,
});

// --- COMPUTED ---
const domainRegex =
  /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
const isValidUrl = computed(() => {
  if (!newSourceUrl.value) return true;
  return domainRegex.test(newSourceUrl.value.trim());
});

// Enforce max 15 display limit on the frontend just to be absolutely certain
const activeSources = computed(() =>
  sources.value.filter((s) => s.isActive).slice(0, 15),
);
const suspendedSources = computed(() =>
  sources.value.filter((s) => !s.isActive),
);
const isQuotaFull = computed(
  () => activeSources.value.length >= quota.value.limit,
);

const progressPercentage = computed(() => {
  const limit = quota.value?.limit;
  if (!limit || limit <= 0) {
    return 0;
  }
  return (activeSources.value.length / limit) * 100;
});

// --- METHODS ---

onMounted(async () => {
  await fetchSourceData();
});

const fetchSourceData = async () => {
  try {
    const response: any = await $fetch("/api/user/sources");

    if (response && response.success) {
      sources.value = response.sources;
      quota.value = response.quota;
    } else {
      // Handle HTTP 200 OK responses where the API reports a logical failure
      console.warn("API responded with a logical failure state:", response);
      showToast(
        response?.message || "Failed to retrieve source data from the server.",
        "error",
      );

      // Optional: Reset local state if data integrity is critical upon failure
      // sources.value = [];
    }
  } catch (error: any) {
    // Handle actual network errors or HTTP 4xx/5xx status codes
    console.error("Failed to load sources", error);
    showToast(
      error?.data?.statusMessage || "Failed to load data. Please refresh.",
      "error",
    );
  }
};

const addNewSource = async () => {
  if (!newSourceUrl.value || !isValidUrl.value || isProcessing.value) return;

  const targetUrl = newSourceUrl.value.trim();

  // Local Duplicate Check
  const normalizedTarget = targetUrl
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  if (sources.value.some((s) => s.url.includes(normalizedTarget))) {
    showToast("This source is already in your network.", "warning");
    return;
  }

  isProcessing.value = true;

  try {
    // 1. Verify against the global intelligence database
    const checkResponse = await $fetch<any>("/api/util/check-source", {
      method: "POST",
      body: { url: targetUrl },
    });

    if (!checkResponse.success) {
      showToast(checkResponse.message || "Invalid domain.", "error");
      isProcessing.value = false;
      return;
    }

    // 2. Pass enriched data to the user's specific source manager endpoint
    const response: any = await $fetch("/api/user/sources/add", {
      method: "POST",
      body: {
        url: checkResponse.url,
        name: checkResponse.name,
        validationStatus: checkResponse.status,
      },
    });

    if (response.success) {
      if (response.activated) {
        showToast(
          response.message || "Source successfully added and activated.",
          "success",
        );
      } else {
        showToast(
          response.message ||
            "Source added to Suspended Zone (Quota limit reached).",
          "warning",
        );
      }

      newSourceUrl.value = "";
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error(error);
    showToast(error.data?.statusMessage || "Failed to add source", "error");
  } finally {
    isProcessing.value = false;
  }
};

const toggleSourceState = async (id: string, activate: boolean) => {
  if (activate && isQuotaFull.value) return;

  isProcessing.value = true;
  try {
    const response: any = await $fetch("/api/user/sources/toggle", {
      method: "PUT",
      body: { sourceId: id, isActive: activate },
    });

    if (response.success) {
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Failed to toggle state", error);
    showToast(
      error.data?.statusMessage || "Failed to toggle source state",
      "error",
    );
  } finally {
    isProcessing.value = false;
  }
};

const deleteSource = async (id: string) => {
  isProcessing.value = true;
  try {
    const response: any = await $fetch(`/api/user/sources/${id}`, {
      method: "DELETE",
    });

    if (response.success) {
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Failed to delete source", error);
    showToast(error.data?.statusMessage || "Failed to delete source", "error");
  } finally {
    isProcessing.value = false;
  }
};

const triggerReDiscovery = async (url: string) => {
  if (isProcessing.value) return;
  isProcessing.value = true;

  showToast("Initializing AI discovery scan...", "warning");

  try {
    const response: any = await $fetch("/api/util/verify-source", {
      method: "POST",
      body: { url },
    });

    if (response.success) {
      showToast("Source verified successfully. Updating network...", "success");
      // Sikeres validáció után frissítjük a UI-t, hogy eltűnjön a gomb és frissüljenek a badge-ek
      await fetchSourceData();
    } else {
      showToast(
        response.message || "Discovery failed. Still no valid feeds found.",
        "error",
      );
    }
  } catch (error: any) {
    console.error("Re-Discovery error:", error);
    showToast("Network error during discovery phase.", "error");
  } finally {
    isProcessing.value = false;
  }
};

// --- UTILS ---

const showToast = (message: string, type: "success" | "warning" | "error") => {
  toast.value = { show: true, message, type };
  setTimeout(() => {
    toast.value.show = false;
  }, 4000);
};

const getDomain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const getPath = (url: string) => {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "" : path.substring(1).replace(/\//g, " > ");
  } catch {
    return "";
  }
};

const getBadges = (status: string) => {
  const badges = [];

  switch (status) {
    case "ACTIVE":
      badges.push({
        label: "Verified Network",
        icon: "verified_user",
        classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]",
        iconClasses: "",
      });
      badges.push({
        label: "RSS Fast-Sync",
        icon: "bolt",
        classes: "bg-[#00363d]/40 text-neon-cyan outline-[#00363d]",
        iconClasses: "",
      });
      break;
    case "PENDING_DISCOVERY":
      badges.push({
        label: "Unknown Source",
        icon: "travel_explore",
        classes:
          "bg-surface-variant/50 text-on-surface-variant outline-outline-variant",
        iconClasses: "",
      });
      badges.push({
        label: "Pending AI Scan",
        icon: "hourglass_empty",
        classes: "bg-[#3a3002]/40 text-tertiary-fixed outline-[#3a3002]",
        iconClasses: "animate-spin-slow",
      });
      break;
    case "NO_RSS_FOUND":
      badges.push({
        label: "Verified Network",
        icon: "verified_user",
        classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]",
        iconClasses: "",
      });
      badges.push({
        label: "Direct Crawl",
        icon: "public",
        classes:
          "bg-surface-variant/50 text-on-surface-variant outline-outline-variant",
        iconClasses: "",
      });
      break;
    case "FAILED":
    case "DOMAIN_DEAD":
      badges.push({
        label: "Connection Error",
        icon: "error",
        classes: "bg-error/20 text-error outline-error/40",
        iconClasses: "",
      });
      break;
  }
  return badges;
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
.animate-spin-slow {
  animation: spin 3s linear infinite;
}
</style>
