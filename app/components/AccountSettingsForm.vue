<template>
  <div class="space-y-4">
    <form @submit.prevent="saveIdentityProfile" class="space-y-4">
      <h5
        class="text-[13px] font-bold text-primary uppercase tracking-widest border-b border-outline-variant/10 pb-1"
      >
        Identity & Social
      </h5>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="flex flex-col gap-1">
            <label class="text-[12px] text-on-surface-variant uppercase tracking-wider">Nickname (Public)</label>
            <div class="mt-2">
                <AvatarPicker
                  :key="avatarPickerKey"
                  v-model="profileForm.avatar"
                  @select="onAvatarSelect"
                />
            </div>
            <input
              v-model="profileForm.nickname"
              type="text"
              placeholder="@tech_guru"
              :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
            />
        </div>

        <div
          class="flex flex-col gap-1 relative"
          id="phone-autocomplete-wrapper"
        >
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider"
            >Phone Number</label
          >
          <div class="flex gap-2 relative">
            <div class="relative shrink-0 w-[95px]">
              <input
                v-model="phoneSearchQuery"
                @focus="handlePhoneFocus"
                type="text"
                placeholder="+353"
                :class="`w-full bg-surface-container border border-outline-variant/30 rounded-lg pl-3 pr-6 py-2 text-sm font-headline font-bold text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
              />
              <span
                class="material-symbols-outlined absolute right-1.5 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant pointer-events-none"
              >
                arrow_drop_down
              </span>
            </div>

            <div class="relative w-full">
              <input
                :value="profileForm.phoneNumber"
                @input="onPhoneInput"
                autocomplete="tel-national"
                type="tel"
                placeholder="87 123 4567"
                :aria-invalid="!!phoneError"
                :class="`w-full bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
              />

              <span
                v-if="profileForm.phoneNumber"
                class="absolute right-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              >
                <span v-if="isPhoneValid" class="material-symbols-outlined text-[18px] text-primary">check_circle</span>
                <span v-else class="material-symbols-outlined text-[18px] text-error">error</span>
              </span>
            </div>
          </div>

          <div v-if="phoneError" class="text-error text-xs mt-1">{{ phoneError }}</div>

          <div
            v-if="isPhoneDropdownOpen"
            class="absolute top-full mt-1 left-0 w-[260px] bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-50 hide-scrollbar flex flex-col"
          >
            <button
              v-for="country in filteredPhoneCountries"
              :key="country.code"
              type="button"
              @click="selectPhoneCode(country.dialCode)"
              class="w-full text-left px-3 py-2.5 hover:bg-surface-container-highest border-b border-outline-variant/10 last:border-none flex items-center justify-between transition-colors"
            >
              <span class="font-body text-sm text-on-surface truncate pr-2">
                <strong class="text-primary mr-2">{{
                  country.dialCode
                }}</strong>
                {{ country.name }}
              </span>
              <span
                v-if="selectedPhoneCode === country.dialCode"
                class="material-symbols-outlined text-primary text-[18px] shrink-0"
                >check</span
              >
            </button>

            <div
              v-if="filteredPhoneCountries.length === 0"
              class="p-4 text-center text-xs text-on-surface-variant"
            >
              No regions found.
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-1 md:col-span-2">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider"
            >Date of Birth</label
          >
          <input
            v-model="profileForm.dateOfBirth"
            type="date"
            :max="maxAllowedDate"
            @click="openDatePicker"
            :class="`block w-full bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors [color-scheme:dark] cursor-pointer appearance-none ${globalInputFontClass}`"
          />
        </div>
      </div>

      <div class="flex justify-end pt-2">
        <button
          type="submit"
          :disabled="isSavingIdentity || !identityDirty"
          :class="identityButtonClass"
        >
          <span v-if="isSavingIdentity" class="material-symbols-outlined animate-spin text-[16px]">sync</span>
          {{ isSavingIdentity ? "Saving..." : "Save Identity" }}
        </button>
      </div>
    </form>

    <div class="h-px w-full bg-outline-variant/10 my-8"></div>

    <form @submit.prevent="saveBillingProfile" class="space-y-4">
      <div
        class="flex items-center ju        Test-NetConnection -ComputerName your_db_host -Port 5432stify-between border-b border-outline-variant/10 pb-1"
      >
        <h5
          class="text-[13px] font-bold text-primary uppercase tracking-widest"
        >
          Physical & Billing Address
        </h5>
        <span
          v-if="!isPro"
          class="text-[9px] font-label text-on-surface-variant uppercase tracking-wider bg-surface-container-highest px-2 py-0.5 rounded"
        >
          Optional for Free Tier
        </span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            First Name <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.firstName"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            Last Name <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.lastName"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>

        <div class="flex flex-col gap-1 md:col-span-2">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            Address Line 1 <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.addressLine1"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
        <div class="flex flex-col gap-1 md:col-span-2">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider"
            >Address Line 2 (Optional)</label
          >
          <input
            v-model="profileForm.addressLine2"
            type="text"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            City <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.city"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            State / Region <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.stateRegion"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            Postal Code <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="profileForm.postalCode"
            type="text"
            :required="isPro"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>

        <div
          class="flex flex-col gap-1 relative"
          id="country-autocomplete-wrapper"
        >
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider flex justify-between"
          >
            Country <span v-if="isPro" class="text-error">*</span>
          </label>
          <input
            v-model="countrySearchQuery"
            @focus="isCountryDropdownOpen = true"
            type="text"
            :required="isPro"
            placeholder="Search for a country..."
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
          <div
            v-if="isCountryDropdownOpen && filteredCountries.length > 0"
            class="absolute top-full mt-1 left-0 right-0 bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl max-h-48 overflow-y-auto z-50 hide-scrollbar"
          >
            <button
              v-for="country in filteredCountries"
              :key="country.code"
              type="button"
              @click="selectCountryForm(country.code, country.name)"
              class="w-full text-left px-3 py-2.5 hover:bg-surface-container-highest border-b border-outline-variant/10 last:border-none flex items-center justify-between transition-colors"
            >
              <span class="font-body text-sm text-on-surface">{{
                country.name
              }}</span>
              <span
                v-if="profileForm.country === country.code"
                class="material-symbols-outlined text-primary text-[18px]"
                >check</span
              >
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-3 pt-2">
        <h5
          class="text-[13px] font-bold text-primary uppercase tracking-widest border-b border-outline-variant/10 pb-1"
        >
          B2B Information
        </h5>
        <div class="flex flex-col gap-1">
          <label
            class="text-[12px] text-on-surface-variant uppercase tracking-wider"
            >VAT Number (Optional)</label
          >
          <input
            v-model="profileForm.vatNumber"
            type="text"
            :class="`bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${globalInputFontClass}`"
          />
        </div>
      </div>

      <div class="flex justify-end pt-4">
        <button
          type="submit"
          :disabled="isSavingBilling || !billingDirty"
          :class="billingButtonClass"
        >
          <span v-if="isSavingBilling" class="material-symbols-outlined animate-spin text-[16px]">sync</span>
          {{ isSavingBilling ? "Saving..." : "Save Billing Info" }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { $api } from "~/utils/api";
import { useI18n } from "vue-i18n";
import { globalCountries } from "~/utils/countries";
import { useUnsavedStore } from "~/stores/unsaved";
import {
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  AsYouType,
} from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js";

const authStore = useAuthStore();
const isPro = computed(() => authStore.user?.tier === "PRO");
const { locale } = useI18n();
import AvatarPicker from "~/components/AvatarPicker.vue";

// Build a map of available avatar basenames -> runtime URLs so we can
// normalize stored avatar identifiers to the Vite-resolved URL used by AvatarPicker.
const _avatarModules = import.meta.glob('/assets/images/avatars/*.{png,jpg,jpeg,webp,svg}', { eager: true, as: 'url' });
const avatarByBasename: Record<string, string> = {};
for (const path in _avatarModules) {
  try {
    const url = (_avatarModules as any)[path] as string;
    const basename = path.slice(path.lastIndexOf('/') + 1);
    avatarByBasename[basename] = url;
  } catch (e) {
    // ignore
  }
}

function resolveAvatarUrl(stored: string | undefined | null) {
  if (!stored) return "";
  // If stored is already a runtime URL that matches one of the values, prefer it
  const values = Object.values(avatarByBasename);
  if (values.includes(stored)) return stored;
  // Otherwise try to extract basename and find a matching runtime url
  const maybeBase = String(stored).split('/').pop() || String(stored);
  return avatarByBasename[maybeBase] || "";
}

function formatDateForInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().split("T")[0] || "";
}

// --- STATE ---
const isSavingIdentity = ref(false);
const isSavingBilling = ref(false);

const profileForm = ref({
  avatar: "",
  nickname: "",
  firstName: "",
  lastName: "",
  phoneNumber: "",
  dateOfBirth: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "",
  vatNumber: "",
});

// --- SANITIZATION & DIRTY TRACKING ---
const initialIdentitySnapshot = ref({ avatar: "", nickname: "", phoneNumber: "", dateOfBirth: "" });
const initialBillingSnapshot = ref({
  firstName: "",
  lastName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "",
  vatNumber: "",
});

const identityDirty = ref(false);
const billingDirty = ref(false);
const avatarPickerKey = ref(0);

// Unsaved forms integration
const unsavedStore = useUnsavedStore();
const IDENTITY_FORM_ID = "profile-identity";
const BILLING_FORM_ID = "profile-billing";

const sanitizeString = (v: any, max = 256) => {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  // Basic HTML-escape to avoid injection in any accidental contexts
  const escaped = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.slice(0, max);
};

const snapshotIdentity = (pf: any) => ({
  avatar: pf.avatar || "",
  nickname: pf.nickname || "",
  phoneNumber: pf.phoneNumber || "",
  dateOfBirth: pf.dateOfBirth || "",
});

const snapshotBilling = (pf: any) => ({
  firstName: pf.firstName || "",
  lastName: pf.lastName || "",
  addressLine1: pf.addressLine1 || "",
  addressLine2: pf.addressLine2 || "",
  city: pf.city || "",
  stateRegion: pf.stateRegion || "",
  postalCode: pf.postalCode || "",
  country: pf.country || "",
  vatNumber: pf.vatNumber || "",
});

const applyAvatarFromProfile = (avatarSource: string | undefined | null) => {
  profileForm.value.avatar = resolveAvatarUrl(avatarSource);
  avatarPickerKey.value += 1;
};

// Update dirty flags whenever the form changes
watch(
  () => profileForm.value,
  (val) => {
    console.debug('profileForm changed, avatar=', val.avatar);
    const idSnap = snapshotIdentity(val);
    const biSnap = snapshotBilling(val);

    identityDirty.value =
      idSnap.avatar !== initialIdentitySnapshot.value.avatar ||
      idSnap.nickname !== initialIdentitySnapshot.value.nickname ||
      idSnap.phoneNumber !== initialIdentitySnapshot.value.phoneNumber ||
      idSnap.dateOfBirth !== initialIdentitySnapshot.value.dateOfBirth;

    billingDirty.value = Object.keys(biSnap).some(
      (k) => (biSnap as any)[k] !== (initialBillingSnapshot.value as any)[k],
    );

    // propagate to global unsaved store
    try {
      unsavedStore.setDirty(IDENTITY_FORM_ID, identityDirty.value);
      unsavedStore.setDirty(BILLING_FORM_ID, billingDirty.value);
    } catch (e) {
      // ignore if store not ready
    }
  },
  { deep: true },
);

// Button classes
const identityButtonClass = computed(() => {
  const base = "px-5 py-2 border border-outline-variant/30 text-on-primary-container font-bold text-xs uppercase tracking-wider rounded-xl flex items-center gap-2";
  const enabled = `bg-primary-container hover:bg-primary-container/80 ${base}`;
  const disabled = `bg-primary-container opacity-50 cursor-not-allowed ${base}`; // no hover when disabled
  return identityDirty.value && !isSavingIdentity.value ? enabled : disabled;
});

const billingButtonClass = computed(() => {
  const base = "px-5 py-2.5 text-on-primary-container font-bold text-xs uppercase tracking-wider rounded-xl flex items-center gap-2 border border-outline-variant/30";
  const enabled = `bg-primary-container hover:bg-primary-container/80 ${base}`;
  const disabled = `bg-primary-container opacity-50 cursor-not-allowed ${base}`;
  return billingDirty.value && !isSavingBilling.value ? enabled : disabled;
});

// --- DATE OF BIRTH LOGIC ---
const MINIMUM_AGE = 16;
const maxAllowedDate = computed(() => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - MINIMUM_AGE);
  return date.toISOString().split("T")[0];
});

const openDatePicker = (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  if (target && "showPicker" in target) {
    target.showPicker();
  }
};

// --- PHONE AUTOCOMPLETE LOGIC ---
const isPhoneDropdownOpen = ref(false);
const phoneSearchQuery = ref("");
const selectedPhoneCode = ref("");
const phoneError = ref<string | null>(null);
const phoneStyleActive = ref(false);

const globalInputFontClass = computed(() =>
  phoneStyleActive.value ? "font-headline font-bold text-on-surface" : "",
);

const selectedPhoneRegion = computed(() => {
  const map = callingCodeMap.value; // alpha2 -> +code
  const dial = selectedPhoneCode.value;
  for (const [cc, dc] of Object.entries(map)) {
    if (dc === dial) return cc;
  }
  return undefined;
});

const isPhoneValid = computed(() => {
  const digits = (profileForm.value.phoneNumber || "").replace(/\D/g, "");
  if (!digits) return false;
  const full = selectedPhoneCode.value ? `${selectedPhoneCode.value}${digits}` : digits;
  try {
    const parsed = parsePhoneNumberFromString(full);
    return !!(parsed && parsed.isValid());
  } catch {
    return false;
  }
});

// Fókuszáláskor kiürítjük a mezőt, hogy azonnal tudjon keresni
const handlePhoneFocus = () => {
  isPhoneDropdownOpen.value = true;
  phoneSearchQuery.value = "";
};

const callingCodeMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  const countries = getCountries();
  for (const code of countries) {
    const dialCode = getCountryCallingCode(code);
    // TS Fix: Only add to map if the dial code actually exists
    if (dialCode) {
      map[code] = `+${dialCode}`;
    }
  }
  return map;
});

const localizedPhoneCountries = computed(() => {
  let displayNames: Intl.DisplayNames;
  try {
    displayNames = new Intl.DisplayNames([locale.value], { type: "region" });
  } catch (e) {
    return [];
  }

  return Object.keys(callingCodeMap.value)
    .map((code) => ({
      code: code,
      name: displayNames.of(code) || code,
      // TS Fix: Add ' || "" ' to guarantee it is always a string, never undefined
      dialCode: callingCodeMap.value[code] || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value));
});

const filteredPhoneCountries = computed(() => {
  if (!phoneSearchQuery.value) return localizedPhoneCountries.value;

  const rawQuery = phoneSearchQuery.value.trim().toLowerCase();
  // Strip out everything except raw numbers
  const queryDigits = rawQuery.replace(/\D/g, "");

  return localizedPhoneCountries.value.filter((c) => {
    // 1. Name Match: Broad search for country names (e.g., typing "ire" finds Ireland)
    const matchName = c.name.toLowerCase().includes(rawQuery);

    // 2. Strict Prefix Match (with +): Evaluates if the user explicitly typed the '+'
    // e.g., typing "+35" will match "+353" but NOT "+135"
    const matchExactCode = c.dialCode.startsWith(rawQuery);

    // 3. Strict Digit Prefix Match (without +): Evaluates if the user only typed numbers
    // e.g., typing "35" will strictly match codes starting with those digits
    const codeDigits = c.dialCode.replace(/\D/g, "");
    const matchDigitCode =
      queryDigits.length > 0 && codeDigits.startsWith(queryDigits);

    return matchName || matchExactCode || matchDigitCode;
  });
});

// Amikor kiválaszt egyet, a keresőmezőbe is beírjuk az értéket
const selectPhoneCode = (dialCode: string) => {
  selectedPhoneCode.value = dialCode;
  phoneSearchQuery.value = dialCode; // Mutatjuk a kiválasztott kódot
  isPhoneDropdownOpen.value = false;
  phoneStyleActive.value = true;
  // Re-format existing local number to the national format for the new country code
  const rawLocal = profileForm.value.phoneNumber || "";
  const digits = rawLocal.replace(/\D/g, "");
  if (digits) {
    // Use AsYouType to reformat for the newly selected region if available
    const region = selectedPhoneRegion.value;
    try {
      const formatter = region ? new AsYouType(region as CountryCode) : new AsYouType();
      const formatted = formatter.input(digits);
      profileForm.value.phoneNumber = formatted;
      // Validate using full international string
      const full = `${selectedPhoneCode.value}${digits}`;
      const parsed = parsePhoneNumberFromString(full);
      phoneError.value = parsed && parsed.isValid() ? null : "Invalid phone number";
    } catch {
      // fallback
      profileForm.value.phoneNumber = rawLocal;
    }
  }
};

// Ha félrekattint, visszaállítjuk az utolsó jó kódra (hogy ne maradjon bent szemét, pl "asd")
const handleClickOutsidePhone = (event: MouseEvent) => {
  const wrapper = document.getElementById("phone-autocomplete-wrapper");
  if (wrapper && !wrapper.contains(event.target as Node)) {
    isPhoneDropdownOpen.value = false;
    phoneSearchQuery.value = selectedPhoneCode.value;
  }
};

// --- COUNTRY AUTOCOMPLETE LOGIC ---
const isCountryDropdownOpen = ref(false);
const countrySearchQuery = ref("");

const initializeCountryQuery = () => {
  const code = profileForm.value.country;
  if (code) {
    try {
      const displayNames = new Intl.DisplayNames([locale.value], {
        type: "region",
      });
      countrySearchQuery.value = displayNames.of(code) || code;
    } catch {
      const fallback = globalCountries.find((c) => c.code === code);
      countrySearchQuery.value = fallback ? fallback.name : code;
    }
  }
};

const localizedCountries = computed(() => {
  let displayNames: Intl.DisplayNames;
  try {
    displayNames = new Intl.DisplayNames([locale.value], { type: "region" });
  } catch (e) {
    return globalCountries;
  }
  return globalCountries
    .map((c) => ({
      code: c.code,
      name: displayNames.of(c.code) || c.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value));
});

const filteredCountries = computed(() => {
  if (!countrySearchQuery.value) return localizedCountries.value;
  return localizedCountries.value.filter((c) =>
    c.name.toLowerCase().includes(countrySearchQuery.value.toLowerCase()),
  );
});

const selectCountryForm = (code: string, name: string) => {
  profileForm.value.country = code;
  countrySearchQuery.value = name;
  isCountryDropdownOpen.value = false;
};

const handleClickOutsideCountry = (event: MouseEvent) => {
  const wrapper = document.getElementById("country-autocomplete-wrapper");
  if (wrapper && !wrapper.contains(event.target as Node)) {
    isCountryDropdownOpen.value = false;
  }
};

// --- LIFECYCLE ---
onMounted(async () => {
  // If store already has profile data, initialize form including avatar
  if (authStore.user?.profile) {
    const p = authStore.user.profile;
    profileForm.value = {
      avatar: "",
      nickname: p.nickname || "",
      firstName: p.firstName || "",
      lastName: p.lastName || "",
      phoneNumber: p.phoneNumber || "",
      dateOfBirth: formatDateForInput(p.dateOfBirth),
      addressLine1: p.addressLine1 || "",
      addressLine2: p.addressLine2 || "",
      city: p.city || "",
      stateRegion: p.stateRegion || "",
      postalCode: p.postalCode || "",
      country: p.country || "",
      vatNumber: p.vatNumber || "",
    };
    applyAvatarFromProfile((p as any).avatarUrl || (p as any).avatar);
    initialIdentitySnapshot.value = snapshotIdentity(profileForm.value);
    initialBillingSnapshot.value = snapshotBilling(profileForm.value);
  }
  // Ensure country display is initialized
  initializeCountryQuery();
  document.addEventListener("click", handleClickOutsideCountry);
  document.addEventListener("click", handleClickOutsidePhone);

  // If the auth store doesn't yet have a profile (e.g. after a fresh login), fetch it
  if (!authStore.user?.profile) {
    try {
      const resp: any = await $api('/api/user/profile');
      if (resp && resp.success && resp.profile) {
        authStore.updateUserProfileLocally(resp.profile);
        // initialize snapshots from fetched profile
        const pf = {
          nickname: resp.profile.nickname || "",
          phoneNumber: resp.profile.phoneNumber || "",
          dateOfBirth: formatDateForInput(resp.profile.dateOfBirth),
          firstName: resp.profile.firstName || "",
          lastName: resp.profile.lastName || "",
          addressLine1: resp.profile.addressLine1 || "",
          addressLine2: resp.profile.addressLine2 || "",
          city: resp.profile.city || "",
          stateRegion: resp.profile.stateRegion || "",
          postalCode: resp.profile.postalCode || "",
          country: resp.profile.country || "",
          vatNumber: resp.profile.vatNumber || "",
        };
        initialIdentitySnapshot.value = snapshotIdentity(pf);
        initialBillingSnapshot.value = snapshotBilling(pf);
      }
    } catch (err) {
      // non-fatal; form will remain empty until store provides data
      console.error('Failed to fetch user profile on mount:', err);
    }
  }

  const existingPhone = authStore.user?.profile?.phoneNumber || "";
  if (existingPhone) {
    // Sort dialing codes by length descending to match longest prefixes first (e.g., +1242 before +1)
    const sortedCodes = Object.values(callingCodeMap.value).sort(
      (a, b) => b.length - a.length,
    );
    const matchingCode = sortedCodes.find((code) =>
      existingPhone.startsWith(code),
    );

    if (matchingCode) {
      selectedPhoneCode.value = matchingCode;
      phoneSearchQuery.value = matchingCode;
      profileForm.value.phoneNumber = existingPhone
        .substring(matchingCode.length)
        .trim();
      phoneStyleActive.value = true;
      // initialize identity snapshot from loaded form
      initialIdentitySnapshot.value = snapshotIdentity(profileForm.value);
    } else {
      profileForm.value.phoneNumber = existingPhone;
    }
  } else {
    selectedPhoneCode.value = "+353";
    phoneSearchQuery.value = "+353";
  }

  // Register forms in global unsaved store
  try {
    unsavedStore.registerForm(IDENTITY_FORM_ID);
    unsavedStore.registerForm(BILLING_FORM_ID);
    // initialize their dirty state
    unsavedStore.setDirty(IDENTITY_FORM_ID, identityDirty.value);
    unsavedStore.setDirty(BILLING_FORM_ID, billingDirty.value);
  } catch (e) {
    // noop
  }

  // Ensure avatar field is initialized if present on profile
  if (authStore.user?.profile?.avatarUrl && !profileForm.value.avatar) {
    applyAvatarFromProfile(authStore.user.profile.avatarUrl as string);
    initialIdentitySnapshot.value = snapshotIdentity(profileForm.value);
  }
});

const onPhoneInput = (event: Event) => {
  const raw = (event.target as HTMLInputElement).value || "";
  const digits = raw.replace(/\D/g, "");

  const region = selectedPhoneRegion.value;
  try {
    const formatter = region ? new AsYouType(region as CountryCode) : new AsYouType();
    const formatted = formatter.input(raw);
    profileForm.value.phoneNumber = formatted;
  } catch {
    profileForm.value.phoneNumber = raw;
  }

  // Validate using full international string
  const full = selectedPhoneCode.value ? `${selectedPhoneCode.value}${digits}` : digits;
  const parsed = parsePhoneNumberFromString(full);
  phoneError.value = parsed && parsed.isValid() ? null : (digits.length > 0 ? "Invalid phone number" : null);
};

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutsideCountry);
  document.removeEventListener("click", handleClickOutsidePhone);
  try {
    unsavedStore.unregisterForm(IDENTITY_FORM_ID);
    unsavedStore.unregisterForm(BILLING_FORM_ID);
  } catch (e) {
    // noop
  }
});

// --- SAVE ACTIONS ---
const saveIdentityProfile = async () => {
  const rawLocalNumber = profileForm.value.phoneNumber.trim();
  const fullPhoneNumber = rawLocalNumber
    ? `${selectedPhoneCode.value}${rawLocalNumber}`
    : "";

  let e164Phone = "";
  if (fullPhoneNumber) {
    const parsed = parsePhoneNumberFromString(fullPhoneNumber);
    if (!parsed || !parsed.isValid()) {
      console.error("Invalid phone number format.");
      return;
    }
    // Use the standardized E.164 representation
    e164Phone = parsed.number; // already in E.164
  }

  isSavingIdentity.value = true;
  try {
    const payload = {
      nickname: sanitizeString(profileForm.value.nickname, 64),
      phoneNumber: e164Phone,
      // Send canonical basename (e.g., "avatar_005.png") so the backend stores a stable id
      avatar: profileForm.value.avatar ? String(profileForm.value.avatar).split('/').pop() : undefined,
      dateOfBirth: profileForm.value.dateOfBirth,
    };

    // Call the backend
    const response = await $api("/api/user/profile/identity", {
      method: "PUT",
      body: payload,
    });

    // Update store state with canonical keys from backend (avatarUrl)
    if (response && response.profile) {
      const prof = response.profile as any;
      const resolvedAvatar = resolveAvatarUrl(prof.avatarUrl || payload.avatar);
      authStore.updateUserProfileLocally({
        nickname: prof.nickname || payload.nickname,
        phoneNumber: prof.phoneNumber || payload.phoneNumber,
        dateOfBirth: prof.dateOfBirth || payload.dateOfBirth,
        avatarUrl: resolvedAvatar || null,
      });
    }
    console.log("Identity profile saved successfully", response);
    // Refresh baseline snapshot so form is no longer dirty
    initialIdentitySnapshot.value = snapshotIdentity(profileForm.value);
    identityDirty.value = false;
  } catch (error: any) {
    console.error("Failed to save identity profile", error);
    // Here you would trigger an error toast (e.g., toast.error(error.message))
  } finally {
    isSavingIdentity.value = false;
  }
};

// Auto-save when avatar is selected from picker
async function onAvatarSelect(url: string) {
  console.debug('onAvatarSelect fired, url=', url, 'current form avatar=', profileForm.value.avatar);
  // v-model already updates profileForm.avatar; we intentionally DO NOT auto-save here
  // The global watcher on profileForm will mark the form dirty and enable the Save button.
  return;
}

const saveBillingProfile = async () => {
  isSavingBilling.value = true;
  try {
    const payload = {
      firstName: sanitizeString(profileForm.value.firstName, 64),
      lastName: sanitizeString(profileForm.value.lastName, 64),
      addressLine1: sanitizeString(profileForm.value.addressLine1, 256),
      addressLine2: sanitizeString(profileForm.value.addressLine2, 256),
      city: sanitizeString(profileForm.value.city, 128),
      stateRegion: sanitizeString(profileForm.value.stateRegion, 128),
      postalCode: sanitizeString(profileForm.value.postalCode, 32),
      country: sanitizeString(profileForm.value.country, 8),
      vatNumber: sanitizeString(profileForm.value.vatNumber, 64),
    };

    // Call the backend
    const response = await $api("/api/user/profile/billing", {
      method: "PUT",
      body: payload,
    });

    // Update store state immediately
    authStore.updateUserProfileLocally(payload);
    console.log("Billing profile saved successfully", response);
    // Refresh baseline snapshot so form is no longer dirty
    initialBillingSnapshot.value = snapshotBilling(profileForm.value);
    billingDirty.value = false;
  } catch (error) {
    console.error("Failed to save billing profile", error);
  } finally {
    isSavingBilling.value = false;
  }
};

// 2. ÚJ: WATCHER - Figyeljük, ha megérkeznek az adatok a store-ból
watch(
  () => authStore.user?.profile,
  (newProfile) => {
    if (newProfile) {
      profileForm.value = {
        avatar: resolveAvatarUrl((newProfile as any).avatarUrl || (newProfile as any).avatar),
        nickname: newProfile.nickname || "",
        firstName: newProfile.firstName || "",
        lastName: newProfile.lastName || "",
        phoneNumber: "", // Ez a lenti logikával frissül
        dateOfBirth: formatDateForInput(newProfile.dateOfBirth),
        addressLine1: newProfile.addressLine1 || "",
        addressLine2: newProfile.addressLine2 || "",
        city: newProfile.city || "",
        stateRegion: newProfile.stateRegion || "",
        postalCode: newProfile.postalCode || "",
        country: newProfile.country || "",
        vatNumber: newProfile.vatNumber || "",
      };

      // Telefon szám szétbontása (a korábbi logika alapján)
      const existingPhone = newProfile.phoneNumber || "";
      if (existingPhone) {
        const sortedCodes = Object.values(callingCodeMap.value).sort(
          (a, b) => b.length - a.length,
        );
        const matchingCode = sortedCodes.find((code) =>
          existingPhone.startsWith(code),
        );
        if (matchingCode) {
          selectedPhoneCode.value = matchingCode;
          phoneSearchQuery.value = matchingCode;
          profileForm.value.phoneNumber = existingPhone
            .substring(matchingCode.length)
            .trim();
          phoneStyleActive.value = true;
        } else {
          profileForm.value.phoneNumber = existingPhone;
        }
      }

      // Ország név inicializálása
      initializeCountryQuery();
      // Initialize snapshots so dirty-tracking has a baseline
      initialIdentitySnapshot.value = snapshotIdentity(profileForm.value);
      initialBillingSnapshot.value = snapshotBilling(profileForm.value);
    }
  },
  { immediate: true }, // Ez fut le azonnal a komponens mountolásakor
);
</script>

<style scoped>
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}
.hide-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
