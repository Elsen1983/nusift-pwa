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
            Back to Login
          </h1>
        </div>
        <div class="hidden md:flex flex-col items-end">
          <span
            class="text-[10px] text-on-surface-variant font-label uppercase tracking-[0.2em]"
            >Step 01/03</span
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
            >Agent Initialization</span
          >
        </div>
        <h2
          class="font-headline text-3xl md:text-4xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          Select Primary Region
        </h2>
        <p class="text-on-surface-variant text-[14px] leading-relaxed">
          Set the baseline region for your intelligence gathering. This helps us
          calibrate your initial news sources. Don't worry—you can still add
          custom domains from anywhere in the world later as our database
          expands.
        </p>
      </section>

      <section class="mb-4 space-y-6">
        <div v-if="detectedCountry" class="mb-8">
          <label
            class="block text-[13px] font-label uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
            >Current Location</label
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
                Set as primary source
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
            >Global Database</label
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
            Region selection prioritizes latency and relevance for your NuSift
            agent. Once calibrated, your feed will begin fetching historical
            data points from these domains to build your initial knowledge
            graph.
          </p>
        </div>
      </section>

      <section class="flex flex-col items-end pt-2">
        <button
          @click="saveAndContinue"
          :disabled="!selectedCountry || isSaving"
          class="flex items-center gap-3 px-6 py-2 rounded-xl transition-all group bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed"
        >
          <span class="font-headline font-bold">
            {{ isSaving ? "Finalizing..." : "Next: Calibrate Sources" }}
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
import { useRouter } from "vue-router";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";

const router = useRouter();
const authStore = useAuthStore();
const agentStore = useAgentStore();

const isSaving = ref(false);
const searchQuery = ref("");
const isDropdownOpen = ref(false);
const selectedCountry = ref("");

const detectedCountry = ref("Ireland");
const detectedCountryCode = ref("IE");

// Teljes globális adatbázis
const countries = [
  { name: "Afghanistan", code: "AF" },
  { name: "Åland Islands", code: "AX" },
  { name: "Albania", code: "AL" },
  { name: "Algeria", code: "DZ" },
  { name: "American Samoa", code: "AS" },
  { name: "AndorrA", code: "AD" },
  { name: "Angola", code: "AO" },
  { name: "Anguilla", code: "AI" },
  { name: "Antarctica", code: "AQ" },
  { name: "Antigua and Barbuda", code: "AG" },
  { name: "Argentina", code: "AR" },
  { name: "Armenia", code: "AM" },
  { name: "Aruba", code: "AW" },
  { name: "Australia", code: "AU" },
  { name: "Austria", code: "AT" },
  { name: "Azerbaijan", code: "AZ" },
  { name: "Bahamas", code: "BS" },
  { name: "Bahrain", code: "BH" },
  { name: "Bangladesh", code: "BD" },
  { name: "Barbados", code: "BB" },
  { name: "Belarus", code: "BY" },
  { name: "Belgium", code: "BE" },
  { name: "Belize", code: "BZ" },
  { name: "Benin", code: "BJ" },
  { name: "Bermuda", code: "BM" },
  { name: "Bhutan", code: "BT" },
  { name: "Bolivia", code: "BO" },
  { name: "Bosnia and Herzegovina", code: "BA" },
  { name: "Botswana", code: "BW" },
  { name: "Bouvet Island", code: "BV" },
  { name: "Brazil", code: "BR" },
  { name: "British Indian Ocean Territory", code: "IO" },
  { name: "Brunei Darussalam", code: "BN" },
  { name: "Bulgaria", code: "BG" },
  { name: "Burkina Faso", code: "BF" },
  { name: "Burundi", code: "BI" },
  { name: "Cambodia", code: "KH" },
  { name: "Cameroon", code: "CM" },
  { name: "Canada", code: "CA" },
  { name: "Cape Verde", code: "CV" },
  { name: "Cayman Islands", code: "KY" },
  { name: "Central African Republic", code: "CF" },
  { name: "Chad", code: "TD" },
  { name: "Chile", code: "CL" },
  { name: "China", code: "CN" },
  { name: "Christmas Island", code: "CX" },
  { name: "Cocos (Keeling) Islands", code: "CC" },
  { name: "Colombia", code: "CO" },
  { name: "Comoros", code: "KM" },
  { name: "Congo", code: "CG" },
  { name: "Congo, The Democratic Republic of the", code: "CD" },
  { name: "Cook Islands", code: "CK" },
  { name: "Costa Rica", code: "CR" },
  { name: "Cote D'Ivoire", code: "CI" },
  { name: "Croatia", code: "HR" },
  { name: "Cuba", code: "CU" },
  { name: "Cyprus", code: "CY" },
  { name: "Czech Republic", code: "CZ" },
  { name: "Denmark", code: "DK" },
  { name: "Djibouti", code: "DJ" },
  { name: "Dominica", code: "DM" },
  { name: "Dominican Republic", code: "DO" },
  { name: "Ecuador", code: "EC" },
  { name: "Egypt", code: "EG" },
  { name: "El Salvador", code: "SV" },
  { name: "Equatorial Guinea", code: "GQ" },
  { name: "Eritrea", code: "ER" },
  { name: "Estonia", code: "EE" },
  { name: "Ethiopia", code: "ET" },
  { name: "Falkland Islands (Malvinas)", code: "FK" },
  { name: "Faroe Islands", code: "FO" },
  { name: "Fiji", code: "FJ" },
  { name: "Finland", code: "FI" },
  { name: "France", code: "FR" },
  { name: "French Guiana", code: "GF" },
  { name: "French Polynesia", code: "PF" },
  { name: "French Southern Territories", code: "TF" },
  { name: "Gabon", code: "GA" },
  { name: "Gambia", code: "GM" },
  { name: "Georgia", code: "GE" },
  { name: "Germany", code: "DE" },
  { name: "Ghana", code: "GH" },
  { name: "Gibraltar", code: "GI" },
  { name: "Greece", code: "GR" },
  { name: "Greenland", code: "GL" },
  { name: "Grenada", code: "GD" },
  { name: "Guadeloupe", code: "GP" },
  { name: "Guam", code: "GU" },
  { name: "Guatemala", code: "GT" },
  { name: "Guernsey", code: "GG" },
  { name: "Guinea", code: "GN" },
  { name: "Guinea-Bissau", code: "GW" },
  { name: "Guyana", code: "GY" },
  { name: "Haiti", code: "HT" },
  { name: "Heard Island and Mcdonald Islands", code: "HM" },
  { name: "Holy See (Vatican City State)", code: "VA" },
  { name: "Honduras", code: "HN" },
  { name: "Hong Kong", code: "HK" },
  { name: "Hungary", code: "HU" },
  { name: "Iceland", code: "IS" },
  { name: "India", code: "IN" },
  { name: "Indonesia", code: "ID" },
  { name: "Iran, Islamic Republic Of", code: "IR" },
  { name: "Iraq", code: "IQ" },
  { name: "Ireland", code: "IE" },
  { name: "Isle of Man", code: "IM" },
  { name: "Israel", code: "IL" },
  { name: "Italy", code: "IT" },
  { name: "Jamaica", code: "JM" },
  { name: "Japan", code: "JP" },
  { name: "Jersey", code: "JE" },
  { name: "Jordan", code: "JO" },
  { name: "Kazakhstan", code: "KZ" },
  { name: "Kenya", code: "KE" },
  { name: "Kiribati", code: "KI" },
  { name: "Korea, Democratic People'S Republic of", code: "KP" },
  { name: "Korea, Republic of", code: "KR" },
  { name: "Kuwait", code: "KW" },
  { name: "Kyrgyzstan", code: "KG" },
  { name: "Lao People'S Democratic Republic", code: "LA" },
  { name: "Latvia", code: "LV" },
  { name: "Lebanon", code: "LB" },
  { name: "Lesotho", code: "LS" },
  { name: "Liberia", code: "LR" },
  { name: "Libyan Arab Jamahiriya", code: "LY" },
  { name: "Liechtenstein", code: "LI" },
  { name: "Lithuania", code: "LT" },
  { name: "Luxembourg", code: "LU" },
  { name: "Macao", code: "MO" },
  { name: "Macedonia, The Former Yugoslav Republic of", code: "MK" },
  { name: "Madagascar", code: "MG" },
  { name: "Malawi", code: "MW" },
  { name: "Malaysia", code: "MY" },
  { name: "Maldives", code: "MV" },
  { name: "Mali", code: "ML" },
  { name: "Malta", code: "MT" },
  { name: "Marshall Islands", code: "MH" },
  { name: "Martinique", code: "MQ" },
  { name: "Mauritania", code: "MR" },
  { name: "Mauritius", code: "MU" },
  { name: "Mayotte", code: "YT" },
  { name: "Mexico", code: "MX" },
  { name: "Micronesia, Federated States of", code: "FM" },
  { name: "Moldova, Republic of", code: "MD" },
  { name: "Monaco", code: "MC" },
  { name: "Mongolia", code: "MN" },
  { name: "Montserrat", code: "MS" },
  { name: "Morocco", code: "MA" },
  { name: "Mozambique", code: "MZ" },
  { name: "Myanmar", code: "MM" },
  { name: "Namibia", code: "NA" },
  { name: "Nauru", code: "NR" },
  { name: "Nepal", code: "NP" },
  { name: "Netherlands", code: "NL" },
  { name: "Netherlands Antilles", code: "AN" },
  { name: "New Caledonia", code: "NC" },
  { name: "New Zealand", code: "NZ" },
  { name: "Nicaragua", code: "NI" },
  { name: "Niger", code: "NE" },
  { name: "Nigeria", code: "NG" },
  { name: "Niue", code: "NU" },
  { name: "Norfolk Island", code: "NF" },
  { name: "Northern Mariana Islands", code: "MP" },
  { name: "Norway", code: "NO" },
  { name: "Oman", code: "OM" },
  { name: "Pakistan", code: "PK" },
  { name: "Palau", code: "PW" },
  { name: "Palestinian Territory, Occupied", code: "PS" },
  { name: "Panama", code: "PA" },
  { name: "Papua New Guinea", code: "PG" },
  { name: "Paraguay", code: "PY" },
  { name: "Peru", code: "PE" },
  { name: "Philippines", code: "PH" },
  { name: "Pitcairn", code: "PN" },
  { name: "Poland", code: "PL" },
  { name: "Portugal", code: "PT" },
  { name: "Puerto Rico", code: "PR" },
  { name: "Qatar", code: "QA" },
  { name: "Reunion", code: "RE" },
  { name: "Romania", code: "RO" },
  { name: "Russian Federation", code: "RU" },
  { name: "RWANDA", code: "RW" },
  { name: "Saint Helena", code: "SH" },
  { name: "Saint Kitts and Nevis", code: "KN" },
  { name: "Saint Lucia", code: "LC" },
  { name: "Saint Pierre and Miquelon", code: "PM" },
  { name: "Saint Vincent and the Grenadines", code: "VC" },
  { name: "Samoa", code: "WS" },
  { name: "San Marino", code: "SM" },
  { name: "Sao Tome and Principe", code: "ST" },
  { name: "Saudi Arabia", code: "SA" },
  { name: "Senegal", code: "SN" },
  { name: "Serbia and Montenegro", code: "CS" },
  { name: "Seychelles", code: "SC" },
  { name: "Sierra Leone", code: "SL" },
  { name: "Singapore", code: "SG" },
  { name: "Slovakia", code: "SK" },
  { name: "Slovenia", code: "SI" },
  { name: "Solomon Islands", code: "SB" },
  { name: "Somalia", code: "SO" },
  { name: "South Africa", code: "ZA" },
  { name: "South Georgia and the South Sandwich Islands", code: "GS" },
  { name: "Spain", code: "ES" },
  { name: "Sri Lanka", code: "LK" },
  { name: "Sudan", code: "SD" },
  { name: "Suriname", code: "SR" },
  { name: "Svalbard and Jan Mayen", code: "SJ" },
  { name: "Swaziland", code: "SZ" },
  { name: "Sweden", code: "SE" },
  { name: "Switzerland", code: "CH" },
  { name: "Syrian Arab Republic", code: "SY" },
  { name: "Taiwan, Province of China", code: "TW" },
  { name: "Tajikistan", code: "TJ" },
  { name: "Tanzania, United Republic of", code: "TZ" },
  { name: "Thailand", code: "TH" },
  { name: "Timor-Leste", code: "TL" },
  { name: "Togo", code: "TG" },
  { name: "Tokelau", code: "TK" },
  { name: "Tonga", code: "TO" },
  { name: "Trinidad and Tobago", code: "TT" },
  { name: "Tunisia", code: "TN" },
  { name: "Turkey", code: "TR" },
  { name: "Turkmenistan", code: "TM" },
  { name: "Turks and Caicos Islands", code: "TC" },
  { name: "Tuvalu", code: "TV" },
  { name: "Uganda", code: "UG" },
  { name: "Ukraine", code: "UA" },
  { name: "United Arab Emirates", code: "AE" },
  { name: "United Kingdom", code: "GB" },
  { name: "United States", code: "US" },
  { name: "United States Minor Outlying Islands", code: "UM" },
  { name: "Uruguay", code: "UY" },
  { name: "Uzbekistan", code: "UZ" },
  { name: "Vanuatu", code: "VU" },
  { name: "Venezuela", code: "VE" },
  { name: "Viet Nam", code: "VN" },
  { name: "Virgin Islands, British", code: "VG" },
  { name: "Virgin Islands, U.S.", code: "VI" },
  { name: "Wallis and Futuna", code: "WF" },
  { name: "Western Sahara", code: "EH" },
  { name: "Yemen", code: "YE" },
  { name: "Zambia", code: "ZM" },
  { name: "Zimbabwe", code: "ZW" },
];

const filteredCountries = computed(() => {
  if (!searchQuery.value) return countries;
  return countries.filter((c) =>
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
  try {
    const data = await $fetch<any>("/api/util/get-location");
    if (data.success && data.countryName && data.countryCode) {
      detectedCountry.value = data.countryName;
      detectedCountryCode.value = data.countryCode;
    }
  } catch (err) {
    console.warn("Internal Location API failed. Using fallback.");
  }
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside);
});

const logoutAndGoBack = async () => {
  if (isSaving.value) return;
  await authStore.logoutIdentity();
  router.replace("/auth");
};

// const saveAndContinue = async () => {
//   if (!selectedCountry.value || isSaving.value) return;

//   isSaving.value = true;

//   try {
//     agentStore.primaryRegion = selectedCountry.value;
//     await new Promise(resolve => setTimeout(resolve, 800));

//     if (authStore.user) {
//       authStore.user.onboardingStep = 1;
//       if (!import.meta.server) {
//         localStorage.setItem('nusift_pwa_profile', JSON.stringify(authStore.user));
//       }
//     }

//     await router.push("/source-calibration");
//   } catch (error) {
//     console.error("Navigation error:", error);
//     isSaving.value = false;
//   }
// };

const saveAndContinue = async () => {
  if (!selectedCountry.value || isSaving.value) return;

  isSaving.value = true;

  try {
    // 1. Eltesszük a Pinia store-ba a kiválasztott országot
    agentStore.primaryRegion = selectedCountry.value;

    // ==========================================
    // 2. HÁTTÉRADATBÁZIS ÉPÍTÉS INDÍTÁSA (SEEDER)
    // ==========================================
    // Nem várjuk meg (nincs await), azonnal megy tovább a kód!
    $fetch("/api/util/seed-region", {
      method: "POST",
      body: { country: selectedCountry.value },
    }).catch((err) => console.warn("Background seeder API failed:", err));

    // 3. UX miatti minimális várakozás (hogy látszódjon a "Finalizing..." gomb)
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 4. Állapotgép (State Machine) frissítése a Guard miatt
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

    // 5. Tovább a következő oldalra
    await router.replace("/source-calibration");
  } catch (error) {
    console.error("Navigation error:", error);
    isSaving.value = false;
  }
};
</script>
