<template>
  <div
    class="bg-surface text-on-surface font-body selection:bg-primary-container selection:text-on-primary-container min-h-screen relative z-0"
  >
    <div
      class="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    
    <div
      class="fixed bottom-0 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-secondary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <header class="fixed top-0 left-0 w-full z-50 bg-[#131313]">
      <div
        class="mx-auto w-full max-w-4xl flex items-center justify-between px-6 py-4"
      >
        <div
          class="flex items-center gap-3 cursor-pointer group"
          @click="logoutAndGoBack"
        >
          <span
            class="material-symbols-outlined text-[#00E5FF] group-hover:-translate-x-1 transition-transform"
            >arrow_back</span
          >
          <h1
            class="font-headline tracking-tighter text-[#00E5FF] group-hover:text-white transition-colors"
          >
            {{ $t("regionCalibration.back_link") }}
          </h1>
        </div>
        <div class="hidden md:flex flex-col items-end">
          <span
            class="text-[10px] text-on-surface-variant font-label uppercase tracking-[0.2em]"
            >{{ $t("regionCalibration.step_indicator") }}</span
          >
          <div
            class="w-32 h-1 bg-surface-container-highest rounded-full mt-1 overflow-hidden"
          >
            <div
              class="h-full w-[33%] bg-primary-container shadow-[0_0_8px_rgba(0,229,255,0.5)]"
            ></div>
          </div>
        </div>
      </div>
    </header>

    <main class="mt-12 pt-6 pb-2 px-6 max-w-4xl mx-auto flex flex-col">
      <section class="mb-4">
        <div
          class="inline-block px-2 py-1 bg-surface-container-highest rounded-lg mb-2"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >{{ $t("regionCalibration.badge_init") }}</span
          >
        </div>
        <h2
          class="font-headline text-3xl md:text-4xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          {{ $t("regionCalibration.title") }}
        </h2>
        <p class="text-on-surface-variant text-[14px] leading-relaxed">
          {{ $t("regionCalibration.description") }}
        </p>
      </section>

      <section class="mb-4 space-y-6">
        <div v-if="detectedCountry" class="mb-8">
          <label
            class="block text-[13px] font-label uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
            >{{ $t("regionCalibration.current_location") }}</label
          >
          <button
            @click="selectCountry(detectedCountryCode, detectedCountry)"
            :disabled="isSaving"
            :class="[
              'w-full md:w-1/2 p-2 rounded-xl border transition-all duration-300 flex items-center gap-4 group text-left disabled:opacity-50 disabled:cursor-not-allowed',
              selectedCountry === detectedCountryCode
                ? 'border-[#00E5FF] bg-primary-container/5 shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                : 'bg-surface-container-low border-white/10 hover:bg-surface-container-high hover:border-white/20',
            ]"
          >
            <div
              class="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center text-primary-container shrink-0"
            >
              <span class="material-symbols-outlined text-xl">location_on</span>
            </div>
            <div class="flex-1">
              <h3
                class="font-headline font-bold text-[17px] text-on-surface leading-tight"
              >
                {{ detectedCountry }}
              </h3>
              <p
                class="text-[10px] text-on-surface-variant font-label uppercase tracking-wider mt-0.5"
              >
                {{ $t("regionCalibration.set_primary") }}
              </p>
            </div>
            <span
              class="material-symbols-outlined text-[#00E5FF] transition-opacity"
              :class="
                selectedCountry === detectedCountryCode
                  ? 'opacity-100'
                  : 'opacity-0'
              "
              >check_circle</span
            >
          </button>
        </div>

        <div class="relative group" id="autocomplete-wrapper">
          <label
            class="block text-[13px] font-label uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
            >{{ $t("regionCalibration.global_db") }}</label
          >
          <div
            class="bg-surface-container-low p-1 rounded-xl transition-all duration-300 focus-within:shadow-[0_0_20px_rgba(0,229,255,0.05)] relative z-20"
          >
            <input
              v-model="searchQuery"
              @focus="isDropdownOpen = true"
              :disabled="isSaving"
              class="w-full bg-surface-container-highest border-none rounded-lg text-on-surface placeholder:text-outline/50 focus:ring-1 focus:ring-primary-fixed/30 font-body h-[52px] text-[14px] font-bold px-4 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="Type to search for a country..."
              type="text"
            />
            <span
              class="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-outline/50 pointer-events-none"
              >search</span
            >
          </div>

          <div
            v-if="isDropdownOpen && filteredCountries.length > 0"
            class="absolute left-0 right-0 mt-2 bg-[#1A1A1A] border border-white/10 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-50"
          >
            <button
              v-for="country in filteredCountries"
              :key="country.code"
              @click="selectCountry(country.code, country.name)"
              class="w-full text-left px-5 py-3.5 hover:bg-white/5 border-b border-white/5 last:border-none flex items-center justify-between transition-colors"
            >
              <span class="font-body text-[15px] text-on-surface">{{
                country.name
              }}</span>
              <span
                v-if="selectedCountry === country.code"
                class="material-symbols-outlined text-[#00E5FF] text-[20px]"
                >check</span
              >
            </button>
          </div>
        </div>

        <div
          class="mt-2 p-2 rounded-2xl border border-outline-variant/10 bg-surface-container-lowest/50 text-[12px] text-on-surface-variant/80 italic font-light"
        >
          <span
            class="material-symbols-outlined text-primary-container/60 float-left mr-3 mt-0.5"
            >info</span
          >
          <p>
            {{ $t("regionCalibration.info_text") }}
          </p>
        </div>
      </section>

      <section class="flex flex-col items-end pt-2">
        <button
          @click="saveAndContinue"
          :disabled="!selectedCountry || isSaving"
          class="flex items-center gap-3 px-6 py-2 rounded-xl transition-all group bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed"
        >
          <span class="font-headline text-[15px] font-bold">
            {{ isSaving ? $t("regionCalibration.btn_finalizing") : $t("regionCalibration.btn_next") }}
          </span>
          <span
            class="material-symbols-outlined transition-transform"
            :class="{
              'animate-spin': isSaving,
              'group-hover:translate-x-1': !isSaving,
            }"
          >
            {{ isSaving ? "sync" : "arrow_forward" }}
          </span>
        </button>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import { $api } from "~/utils/api";
import { useI18n } from "vue-i18n";
import { globalCountries } from "~/utils/countries";

const navigate = useSovereignNavigate();
const authStore = useAuthStore();
const agentStore = useAgentStore();
const { locale } = useI18n();

const isSaving = ref(false);
const searchQuery = ref("");
const isDropdownOpen = ref(false);
const selectedCountry = ref("");

const detectedCountryCode = ref("IE");
// SSR-compatible way to get user's location (with fallback to Ireland if it fails or is unavailable)
const { data: locationData } = await useAsyncData('userLocation', () => 
  $api<any>('/api/util/get-location')
);
// If location data is available and contains a country code, use it to set the detected country code. The computed property will automatically update the displayed country name in the UI.
if (locationData.value && locationData.value.countryCode) {
  detectedCountryCode.value = locationData.value.countryCode;
}

// ÚJ: A név automatikusan fordítódik a kód és a locale alapján
const detectedCountry = computed(() => {
  try {
    const displayNames = new Intl.DisplayNames([locale.value], { type: 'region' });
    return displayNames.of(detectedCountryCode.value) || "Ireland";
  } catch {
    return "Ireland"; // Biztonsági fallback régebbi böngészőkhöz
  }
});


const localizedCountries = computed(() => {
  let displayNames: Intl.DisplayNames;
  try {
    displayNames = new Intl.DisplayNames([locale.value], { type: 'region' });
  } catch (e) {
    return globalCountries; // Fallback, ha a böngésző nem támogatja az API-t
  }

  return globalCountries.map(c => ({
    code: c.code,
    name: displayNames.of(c.code) || c.name // Név lecserélése a lefordítottra
  })).sort((a, b) => a.name.localeCompare(b.name, locale.value)); // Újrarendezés az adott nyelv ABC-je szerint
});

// MÓDOSÍTOTT: Keresés már az új, lefordított listában történik
const filteredCountries = computed(() => {
  if (!searchQuery.value) return localizedCountries.value;
  return localizedCountries.value.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.value.toLowerCase()),
  );
});

const selectCountry = (code: string, name: string) => {
  selectedCountry.value = code;
  searchQuery.value = name;
  isDropdownOpen.value = false;
};

const handleClickOutside = (event: MouseEvent) => {
  const wrapper = document.getElementById("autocomplete-wrapper");
  if (wrapper && !wrapper.contains(event.target as Node)) {
    isDropdownOpen.value = false;
  }
};

onMounted(async () => {
  document.addEventListener("click", handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside);
});

const logoutAndGoBack = async () => {
  if (isSaving.value) return;
  await authStore.logoutIdentity();
  navigate.hardRedirect("/");
};

const saveAndContinue = async () => {
  if (!selectedCountry.value || isSaving.value) return;

  isSaving.value = true;

  try {
    // 1. Eltesszük a Pinia store-ba a kiválasztott országot
    agentStore.primaryRegion = selectedCountry.value;

    // ==========================================
    // 2. UX miatti minimális várakozás (hogy látszódjon a "Finalizing..." gomb)
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 3. Állapotgép (State Machine) frissítése a Guard miatt
    if (authStore.user) {
      authStore.user.onboardingStep = 1;
      authStore.user.primaryRegion = selectedCountry.value; // NEW: Sync state

      if (!import.meta.server) {
        localStorage.setItem(
          "nusift_pwa_profile",
          JSON.stringify(authStore.user),
        );
      }
    }

    // 4. Tovább a következő oldalra
    navigate.push("/source-calibration");
  } catch (error) {
    console.error("Navigation error:", error);
    isSaving.value = false;
  }
};
</script>
