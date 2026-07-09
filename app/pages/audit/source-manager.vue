<template>
  <div class="relative min-h-screen">
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-neon-cyan/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    <!-- <div
      class="fixed bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-secondary-container/10 blur-[140px] rounded-full -z-10 pointer-events-none"
    ></div> -->

    <main class="pt-5 pb-5 px-4 max-w-5xl mx-auto space-y-3 relative z-10">
      <!-- 1. HEADER SECTION -->
      <section class="mb-6 px-2">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-2"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
          >
            {{ $t("sourceManager.header.badge") }}
          </span>
        </div>
        <h2
          class="font-lg text-3xl md:text-5xl font-bold text-black dark:text-white leading-tight tracking-tight mb-4"
        >
          {{ $t("sourceManager.header.title") }}
        </h2>
        <p
          class="text-on-surface-variant text-[13px] max-w-2xl leading-relaxed font-body"
        >
          {{ $t("sourceManager.header.description") }}
        </p>
      </section>

      <!-- 2. QUOTA SECTION -->
      <section class="mb-8">
        <div
          class="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-4 md:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-6 shadow-[0_4px_12px_rgba(0,0,0,0.2)] w-full"
        >
          <div class="flex flex-col gap-4 w-full md:flex-1 md:pr-4">
            <div class="flex flex-row items-baseline gap-2 w-full">
              <span
                class="text-[11px] font-label font-bold text-on-surface-variant uppercase tracking-widest"
              >
                {{ $t("sourceManager.quota.tier_status_label") }}:
              </span>
              <span
                class="text-[12px] font-label tracking-wide"
                :class="quota.tier === 'PRO' ? 'text-[#fec931]' : 'text-white'"
              >
                {{
                  quota.tier === "PRO"
                    ? $t("sourceManager.quota.tier_pro")
                    : $t("sourceManager.quota.tier_free")
                }}
              </span>
            </div>

            <div class="flex flex-col gap-2 w-full">
              <span
                class="text-[11px] font-label font-bold text-on-surface-variant uppercase tracking-widest"
              >
                {{ $t("sourceManager.quota.quota_label") }}:
                <span
                  class="text-[12px] font-label tracking-wide text-neon-cyan ml-1"
                  >{{ activeSources.length }}/{{ quota.limit }}</span
                >
              </span>
              <div
                class="h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden flex"
              >
                <div
                  class="h-full bg-gradient-to-r from-[#00E5FF] to-[#9cf0ff] rounded-full transition-all duration-500"
                  :style="{ width: `${progressPercentage}%` }"
                ></div>
              </div>
            </div>
          </div>

          <div
            v-if="quota.tier === 'FREE'"
            class="w-full md:w-auto shrink-0 flex justify-end"
          >
            <button
              class="w-full sm:w-max bg-surface-container-high hover:bg-surface-container-highest transition-colors px-6 py-3 rounded-xl flex items-center justify-between sm:justify-center gap-5 border border-yellow-100 border-outline-variant/80 hover:border-neon-cyan disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div class="flex flex-col items-start text-left">
                <span
                  class="font-label text-[13px] font-bold text-neon-cyan uppercase tracking-wider leading-tight"
                >
                  {{ $t("sourceManager.quota.upgrade_btn_title") }}
                </span>
                <span
                  class="font-label text-[10px] text-neon-cyan/70 uppercase tracking-widest leading-tight mt-0.5"
                >
                  {{ $t("sourceManager.quota.upgrade_btn_sub") }}
                </span>
              </div>
              <span class="material-symbols-outlined text-neon-cyan text-[22px]"
                >rocket_launch</span
              >
            </button>
          </div>
        </div>
      </section>

      <!-- 3. INPUT HUB SECTION -->
      <section class="mb-10">
        <div
          class="bg-surface-container rounded-2xl p-4 md:p-5 shadow-[0_0_24px_0_rgba(255,255,255,0.05)] border border-white/50 relative overflow-hidden w-full"
        >
          <div class="relative z-10 space-y-4">
            <div class="relative group">
              <label
                for="source-url-input"
                class="block text-[13px] font-label font-bold uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
              >
                {{ $t("sourceManager.input.label") }}
              </label>
              <div
                class="bg-surface-container-low p-1 rounded-xl transition-all duration-300 focus-within:shadow-[0_0_20px_rgba(0,229,255,0.05)] outline outline-1 outline-white/50"
              >
                <input
                  id="source-url-input"
                  v-model="newSourceUrl"
                  @input="handleSourceUrlInput"
                  @keyup.enter="addNewSource"
                  class="source-url-input w-full bg-surface-container-highest focus:bg-surface-bright transition-colors duration-300 border-none rounded-lg text-on-surface placeholder:text-outline/50 focus:ring-1 focus:ring-neon-cyan/30 font-body h-[52px] text-[16px] font-bold px-4 disabled:opacity-50 outline-none"
                  :style="sourceUrlInputStyle"
                  :placeholder="$t('sourceManager.input.placeholder')"
                  type="text"
                  inputmode="url"
                  autocapitalize="off"
                  autocomplete="off"
                  autocorrect="off"
                  spellcheck="false"
                  :disabled="isProcessing"
                />
              </div>
              <p
                v-if="newSourceUrl && !isValidUrl"
                class="text-texterror text-[12px] font-label mt-1 ml-1 leading-tight text-red-500"
              >
                {{ $t("sourceManager.input.error_format") }}
              </p>
            </div>

            <div class="flex justify-end">
              <button
                @click="addNewSource"
                :disabled="!newSourceUrl || !isValidUrl || isProcessing"
                class="bg-primary-container text-on-primary-container font-bold px-6 py-3 rounded-xl flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-95 transition-all shadow-[0_8px_20px_rgba(0,229,255,0.15)] group w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span
                  v-if="!isProcessing"
                  class="material-symbols-outlined text-xl"
                  >add</span
                >
                <span
                  v-else
                  class="animate-spin h-5 w-5 border-2 border-on-primary-container border-t-transparent rounded-full"
                ></span>
                <span class="text-[14px] uppercase tracking-wider">{{
                  $t("sourceManager.input.btn_add")
                }}</span>
              </button>
            </div>
          </div>

          <Transition name="fade">
            <div
              v-if="toast.show"
              :class="[
                'mt-5 flex items-center gap-2 text-sm font-label px-4 py-3 rounded-lg inline-flex outline outline-1 transition-all relative z-10',
                toast.type === 'warning'
                  ? 'text-tertiary-fixed bg-tertiary-fixed/10 outline-tertiary-fixed/20'
                  : toast.type === 'error'
                    ? 'text-texterror bg-error/10 outline-error/20'
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
        </div>
      </section>

      <!-- 4. ACTIVE SOURCES SECTION (COLLAPSIBLE) -->
      <section class="mb-10">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-primary-container/50 shadow-[0_0_15px_rgba(0,229,255,0.05)]"
        >
          <div
            @click="isActiveSectionOpen = !isActiveSectionOpen"
            class="w-full flex items-center justify-between p-4 cursor-pointer hover:bg-surface-container-low/80 transition-colors select-none"
          >
            <h2
              class="font-headline text-[16px] font-bold text-black dark:text-white flex items-center gap-2"
            >
              <span
                class="material-symbols-outlined text-xxl text-primary-container"
                >visibility</span
              >
              {{ $t("sourceManager.active_zone.title") }}
            </h2>
            <div class="flex items-center gap-3">
              <span
                class="bg-surface-container-highest px-3 py-1 rounded-full text-[12px] font-label font-bold text-neon-cyan"
              >
                {{ activeSources.length }} / {{ quota.limit }}
              </span>
              <span
                class="material-symbols-outlined text-on-surface-variant transition-transform duration-300"
                :class="{ 'rotate-180': isActiveSectionOpen }"
              >
                expand_more
              </span>
            </div>
          </div>

          <div
            v-show="isActiveSectionOpen"
            class="p-3 md:p-5 border-t border-outline-variant/10 bg-surface-container-low/30"
          >
            <div class="grid grid-cols-1 gap-3" v-if="activeSources.length > 0">
              <ActiveSourceCard
                v-for="source in activeSources"
                :key="source.id"
                :source="source"
                :is-processing="isProcessing"
                @suspend="toggleSourceState($event, false)"
                @delete="deleteSource($event)"
                @save-feed="saveFeedOverride"
              />
            </div>
            <div
              v-else
              class="text-center py-8 text-on-surface-variant font-body bg-surface-container-lowest rounded-xl outline outline-1 outline-outline-variant/10"
            >
              {{ $t("sourceManager.active_zone.empty") }}
            </div>
          </div>
        </div>
      </section>

      <!-- 5. SUSPENDED SOURCES SECTION (COLLAPSIBLE) -->
      <section class="mb-10">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-outline-variant/80 shadow-lg"
        >
          <div
            @click="isSuspendedSectionOpen = !isSuspendedSectionOpen"
            class="w-full flex items-center justify-between p-4 cursor-pointer hover:bg-surface-container-low/80 transition-colors select-none"
          >
            <h3
              class="font-headline text-[16px] font-bold text-black dark:text-white flex items-center gap-2"
            >
              <span
                class="material-symbols-outlined text-xxl text-on-surface-variant"
                >visibility_off</span
              >
              {{ $t("sourceManager.suspended_zone.title") }}
            </h3>
            <div class="flex items-center gap-3">
              <span
                class="bg-surface-container-highest px-3 py-1 rounded-full text-[12px] font-label font-bold text-on-surface-variant"
              >
                {{ suspendedSources.length }}
              </span>
              <span
                class="material-symbols-outlined text-on-surface-variant transition-transform duration-300"
                :class="{ 'rotate-180': isSuspendedSectionOpen }"
              >
                expand_more
              </span>
            </div>
          </div>

          <div
            v-show="isSuspendedSectionOpen"
            class="p-3 md:p-5 border-t border-outline-variant/10 bg-surface-container-low/30"
          >
            <div
              class="grid grid-cols-1 gap-3"
              v-if="suspendedSources.length > 0"
            >
              <SuspendedSourceCard
                v-for="source in suspendedSources"
                :key="source.id"
                :source="source"
                :is-processing="isProcessing"
                :is-quota-full="isQuotaFull"
                @activate="toggleSourceState($event, true)"
                @delete="deleteSource($event)"
                @rediscover="triggerReDiscovery($event)"
                @save-feed="saveFeedOverride"
              />

              <button
                v-if="isQuotaFull && quota.tier === 'FREE'"
                class="w-full mt-5 sm:w-max md:w-1/2 bg-surface-container-high hover:bg-surface-container-highest transition-colors px-6 py-3 rounded-xl flex items-center justify-between sm:justify-center gap-5 border border-yellow-100 border-outline-variant/80 hover:border-neon-cyan disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <div class="flex flex-col items-start text-left">
                  <span
                    class="font-label text-[13px] font-bold text-neon-cyan uppercase tracking-wider leading-tight transition-all"
                  >
                    {{ $t("sourceManager.quota.upgrade_btn_title") }}
                  </span>
                  <span
                    class="font-label text-[10px] text-neon-cyan/70 uppercase tracking-widest leading-tight mt-0.5"
                  >
                    {{ $t("sourceManager.quota.upgrade_btn_sub") }}
                  </span>
                </div>
                <span
                  class="material-symbols-outlined text-neon-cyan text-[22px]"
                  >rocket_launch</span
                >
              </button>
            </div>
            <div
              v-else
              class="text-center py-8 text-outline font-body text-sm bg-surface-container-lowest/50 rounded-xl"
            >
              {{ $t("sourceManager.suspended_zone.empty") }}
            </div>
          </div>
        </div>
      </section>

      <!-- 6. RESTRICTED SOURCES SECTION (COLLAPSIBLE) -->
      <section class="mb-10">
        <div
          class="bg-surface-container-low rounded-3xl overflow-hidden border border-warning/50 shadow-lg"
        >
          <div
            @click="isRestrictedSectionOpen = !isRestrictedSectionOpen"
            class="w-full flex items-center justify-between p-4 cursor-pointer hover:bg-surface-container-low/80 transition-colors select-none"
          >
            <h2
              class="font-headline text-[16px] font-bold text-black dark:text-white flex items-center gap-2"
            >
              <span class="material-symbols-outlined text-xxl text-warning"
                >visibility_lock</span
              >
              {{ $t("sourceManager.restricted_zone.title") }}
            </h2>
            <div class="flex items-center gap-3">
              <span
                class="bg-surface-container-highest px-3 py-1 rounded-full text-[12px] font-label font-bold text-neon-cyan"
              >
                {{ restrictedSources.length }}
              </span>
              <span
                class="material-symbols-outlined text-on-surface-variant transition-transform duration-300"
                :class="{ 'rotate-180': isRestrictedSectionOpen }"
              >
                expand_more
              </span>
            </div>
          </div>

          <div
            v-show="isRestrictedSectionOpen"
            class="p-3 md:p-5 border-t border-outline-variant/10 bg-surface-container-low/30"
          >
            <div
              class="grid grid-cols-1 gap-3"
              v-if="restrictedSources.length > 0"
            >
              <RestrictedSourceCard
                v-for="source in restrictedSources"
                :key="source.id"
                :source="source"
                :is-processing="isProcessing"
                @delete="deleteSource($event)"
              />
            </div>
            <div
              v-else
              class="text-center py-8 text-on-surface-variant font-body bg-surface-container-lowest rounded-xl outline outline-1 outline-outline-variant/10"
            >
              {{ $t("sourceManager.restricted_zone.empty") }}
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAgentStore } from "~/stores/agent";
import { useAuthStore } from "~/stores/auth";

definePageMeta({ layout: "app-layout" });

interface SourceItem {
  url: string;
  name: string;
  status: string;
  language: string; // <-- Ezt eddig eldobtuk
}

const { t } = useI18n();
const colorMode = useColorMode();
const agentStore = useAgentStore();
const authStore = useAuthStore();

// --- STATE ---
const newSourceUrl = ref("");
const isProcessing = ref(false);
const toast = ref({ show: false, message: "", type: "success" });

const isActiveSectionOpen = ref(false);
const isSuspendedSectionOpen = ref(false);
const isRestrictedSectionOpen = ref(false);

const sources = ref<any[]>([]);
const quota = ref({
  tier: "FREE",
  limit: 5,
  activeCount: 0,
  availableSlots: 5,
});

// --- COMPUTED ---
const domainRegex =
  /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?(\?[^\s]*)?$/;
const isValidUrl = computed(() => {
  if (!newSourceUrl.value) return true;
  return domainRegex.test(newSourceUrl.value.trim());
});

const sourceUrlInputStyle = computed(() =>
  colorMode.value === "light"
    ? { backgroundColor: "rgb(var(--color-surface-container-lowest))" }
    : { backgroundColor: "rgb(var(--color-surface-container-highest))" },
);

const handleSourceUrlInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;

  const normalizedValue = target.value.toLowerCase();
  if (normalizedValue !== newSourceUrl.value) {
    newSourceUrl.value = normalizedValue;
  }
  if (target.value !== normalizedValue) {
    target.value = normalizedValue;
  }
};

// Restricted Array
const restrictedSources = computed(() => {
  return sources.value
    .filter(
      (s) =>
        s.validationStatus === "FAILED" ||
        s.validationStatus === "DOMAIN_DEAD"
    )
    .sort((a, b) => {
      // JAVÍTÁS: Safe string fallback a toLowerCase() előtt
      const nameA = (a.name || getDomain(a?.url || "")).toLowerCase();
      const nameB = (b.name || getDomain(b?.url || "")).toLowerCase();
      return nameA.localeCompare(nameB);
    });
});

console.log("Restricted Sources:", restrictedSources.value);

// Filter Active (Must NOT be failed)
const activeSources = computed(() => {
  return sources.value
    .filter(
      (s) =>
        s.isActive &&
        s.validationStatus !== "FAILED" &&
        s.validationStatus !== "DOMAIN_DEAD"
    )
    .sort((a, b) => {
      // JAVÍTÁS: Safe string fallback
      const nameA = (a.name || getDomain(a?.url || "")).toLowerCase();
      const nameB = (b.name || getDomain(b?.url || "")).toLowerCase();
      return nameA.localeCompare(nameB);
    })
    .slice(0, 15);
});

const suspendedSources = computed(() => {
  return sources.value
    .filter(
      (s) =>
        !s.isActive &&
        s.validationStatus !== "FAILED" &&
        s.validationStatus !== "DOMAIN_DEAD"
    )
    .sort((a, b) => {
      // JAVÍTÁS: Safe string fallback
      const nameA = (a.name || getDomain(a?.url || "")).toLowerCase();
      const nameB = (b.name || getDomain(b?.url || "")).toLowerCase();
      return nameA.localeCompare(nameB);
    });
});
const isQuotaFull = computed(
  () => activeSources.value.length >= quota.value.limit,
);

// Enforced strict mathematical boundary to ensure reactive rendering scales correctly
const progressPercentage = computed(() => {
  const currentLimit = quota.value?.limit || 5;
  const currentActive = activeSources.value.length;

  if (currentLimit <= 0) return 0;
  return Math.min((currentActive / currentLimit) * 100, 100);
});


// Helper a backendről érkező üzenetek dinamikus fordításához
const parseApiMessage = (msg: string | undefined, fallbackText: string) => {
  if (!msg) return fallbackText;
  // Ha a string a mi API hibakulcsunkkal kezdődik, lefordítjuk, különben kiírjuk nyersen
  return msg.startsWith('api_errors.') ? t(msg) : msg;
};

// --- METHODS ---

onMounted(async () => {
  await fetchSourceData();
});

const fetchSourceData = async () => {
  try {
    const response = await $api<any>("/api/user/sources");

    if (response && response.success) {
      // 1. Update local component UI state
      sources.value = response.sources;
      quota.value = response.quota;

      // 2. Update Agent Store (The runtime memory for the AI feed)
      agentStore.topSources = response.sources;

      // 3. Update Auth Store & PWA LocalStorage (For persistence across reloads)
      if (authStore.user) {
        authStore.user.topSources = response.sources;

        if (!import.meta.server) {
          localStorage.setItem(
            "nusift_pwa_profile",
            JSON.stringify(authStore.user),
          );
        }
      }
    } else {
      console.warn("API responded with a logical failure state:", response);
      showToast(
        response?.message || t("sourceManager.toasts.fetch_logic_error"),
        "error",
      );
    }
  } catch (error: any) {
    console.error("Failed to load sources", error);
    // Tiszta kiolvasás az api.ts normalizációjából
    showToast(
      error.response?._data?.normalizedMessage ||
        t("sourceManager.toasts.fetch_network_error"),
      "error",
    );
  }
};

const addNewSource = async () => {
  if (!newSourceUrl.value || !isValidUrl.value || isProcessing.value) return;

  const targetUrl = newSourceUrl.value.trim();
  const normalizedTarget = targetUrl
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");

  if (sources.value.some((s) => s.url.includes(normalizedTarget))) {
    showToast(t("sourceManager.toasts.duplicate"), "warning");
    return;
  }

  isProcessing.value = true;

  try {
    const checkResponse = await $api<any>("/api/util/check-source", {
      method: "POST",
      body: {
        url: targetUrl,
        language: authStore.user?.preferredLanguage || "en",
      },
    });

    if (!checkResponse.success) {
      const errorText = parseApiMessage(checkResponse.message, t("sourceManager.toasts.invalid_domain"));
      showToast(errorText, "error");
      isProcessing.value = false;
      return;
    }

    const response = await $api<any>("/api/user/sources/add", {
      method: "POST",
      body: {
        url: checkResponse.url,
        name: checkResponse.name,
        validationStatus: checkResponse.status,
        language: checkResponse.detectedLanguage,
      },
    });

    if (response.success) {
      // 1. Intercept Restricted Domains
      if (
        checkResponse.status === "FAILED" ||
        checkResponse.status === "DOMAIN_DEAD"
      ) {
        showToast(t("sourceManager.toasts.add_restricted"), "warning");
      }
      // 2. Handle Normal Activated Domains
      else if (response.activated) {
        showToast(
          // Use translation key as primary, fallback to backend message if translation is missing
          t("sourceManager.toasts.add_success") || response.message,
          "success",
        );
      }
      // 3. Handle Normal Suspended Domains (Quota Full)
      else {
        showToast(
          t("sourceManager.toasts.add_suspended") || response.message,
          "warning",
        );
      }

      newSourceUrl.value = "";
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Nuxt 4 Global Intercepted Error:", error);

    // Tiszta kiolvasás az api.ts által normalizált objektumból
    const errorMessage = parseApiMessage(
      error.response?._data?.normalizedMessage, 
      t("sourceManager.toasts.add_failed")
    );

    showToast(errorMessage, "error");
  } finally {
    isProcessing.value = false;
  }
};

const toggleSourceState = async (id: string, activate: boolean) => {
  if (activate && isQuotaFull.value) return;

  isProcessing.value = true;
  try {
    const response = await $api<any>("/api/user/sources/toggle", {
      method: "PUT",
      body: { sourceId: id, isActive: activate },
    });

    if (response.success) {
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Failed to toggle state", error);
    const errorMessage = parseApiMessage(
      error.response?._data?.normalizedMessage, 
      t("sourceManager.toasts.toggle_failed")
    );
    showToast(errorMessage, "error");
  } finally {
    isProcessing.value = false;
  }
};

const deleteSource = async (id: string) => {
  isProcessing.value = true;
  try {
    const response = await $api<any>(`/api/user/sources/${id}`, {
      method: "DELETE",
    });

    if (response.success) {
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Failed to delete source", error);
    showToast(
      error.response?._data?.normalizedMessage ||
        t("sourceManager.toasts.delete_failed"),
      "error",
    );
  } finally {
    isProcessing.value = false;
  }
};

const triggerReDiscovery = async (url: string) => {
  if (isProcessing.value) return;
  isProcessing.value = true;

  showToast(t("sourceManager.toasts.discovery_init"), "warning");

  try {
    const response = await $api<any>("/api/util/verify-source", {
      method: "POST",
      body: { url },
    });

    if (response.success) {
      showToast(t("sourceManager.toasts.discovery_success"), "success");
      await fetchSourceData();
    } else {
      showToast(
        response.message || t("sourceManager.toasts.discovery_failed"),
        "error",
      );
    }
  } catch (error: any) {
    console.error("Re-Discovery error:", error);
    showToast(
      error.response?._data?.normalizedMessage ||
        t("sourceManager.toasts.discovery_error"),
      "error",
    );
  } finally {
    isProcessing.value = false;
  }
};

const saveFeedOverride = async (payload: { subscriptionId: string; feedUrl: string }) => {
  if (isProcessing.value) return;
  isProcessing.value = true;

  try {
    const response = await $api<any>("/api/user/sources/feed", {
      method: "PUT",
      body: payload,
    });

    if (response?.ok) {
      showToast(t("sourceManager.toasts.feed_saved"), "success");
      await fetchSourceData();
    }
  } catch (error: any) {
    console.error("Failed to save manual feed", error);
    showToast(
      error.response?._data?.normalizedMessage ||
        error?.statusMessage ||
        t("sourceManager.toasts.feed_save_failed"),
      "error",
    );
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
  if (!url) return "Ismeretlen Forrás"; // JAVÍTÁS: Ha nincs URL, ne dobjon hibát
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
.rotate-180 {
  transform: rotate(180deg);
}
</style>
