<template>
  <div
    class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container relative overflow-hidden"
  >
    <ClientOnly>
      <PwaInstallBanner v-if="isLanguageReady" />
    </ClientOnly>

    <ClientOnly>
      <LanguageSelectorModal @language-selected="handleLanguageSelection" />
    </ClientOnly>

    <div
      v-if="isLoading"
      class="fixed inset-0 backdrop-blur-sm bg-surface/80 z-[100] flex flex-col items-center justify-center"
    >
      <div class="relative w-16 h-16 mb-6">
        <div
          class="absolute inset-0 rounded-full border-4 border-primary-container/20"
        ></div>
        <div
          class="absolute inset-0 rounded-full border-4 border-t-primary-container animate-spin"
        ></div>
      </div>
      <p
        class="font-label text-sm text-on-surface tracking-widest uppercase animate-pulse text-center px-6"
      >
        {{
          isResettingPassword
            ? $t("auth.loading.resetting")
            : isRegistering
              ? $t("auth.loading.registering")
              : $t("auth.loading.initializing")
        }}
      </p>
    </div>
    <main
      class="min-h-screen flex flex-col items-center justify-center px-8 py-6 max-w-md mx-auto relative z-10"
    >
      <!-- LOGO & DYNAMIC HEADER -->
      <section class="w-full flex flex-col items-center mb-6">
        <div class="relative w-[125px] h-[125px] mb-4 shadow-xl rounded-xl">
          <div
            class="absolute inset-0 bg-primary-container/10 blur-xl rounded-full"
          ></div>
          <div
            class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl shadow-2xl"
          >
            <img
              src="~/assets/images/NuSift_Logo_Blue.png"
              alt="NuSift Logo"
              class="w-full h-full object-cover"
            />
          </div>
        </div>
        <h1
          class="font-headline text-3xl font-bold tracking-tight text-on-surface text-center transition-all duration-500"
        >
          {{
            isResettingPassword
              ? $t("auth.heading.reset")
              : isRegistering
                ? $t("auth.heading.register")
                : $t("auth.heading.login")
          }}
        </h1>
        <p
          class="text-[11px] text-on-surface-variant mt-2 font-label uppercase tracking-[0.25em] text-center opacity-80"
        >
          {{
            isResettingPassword
              ? $t("auth.subheading.reset")
              : isRegistering
                ? $t("auth.subheading.register")
                : $t("auth.subheading.login")
          }}
        </p>
      </section>

      <div
        v-if="resetSuccessMessage"
        class="w-full mb-4 p-3 bg-primary-container/10 border border-primary-container/30 rounded-xl"
      >
        <p class="text-xs font-label text-[#00E5FF] leading-tight text-center">
          {{ resetSuccessMessage }}
        </p>
      </div>

      <!-- 1. PROGRESSIVE DISCLOSURE: EMAIL FORM VS BUTTON -->
      <section class="w-full">
        <Transition name="fade-slide" mode="out-in">
          <!-- STATE A: EMAIL FORM EXPANDED -->
          <div v-if="showEmailForm || isResettingPassword" class="w-full">
            <!-- UX Escape Hatch -->
            <button
              v-if="!isResettingPassword"
              @click="showEmailForm = false"
              class="mb-4 flex items-center justify-center w-full gap-2 text-[11px] font-label font-bold text-on-surface-variant hover:text-primary-container transition-colors uppercase tracking-widest focus:outline-none"
            >
              <span class="material-symbols-outlined text-[14px]"
                >arrow_back</span
              >
              {{ $t("auth.buttons.back_to_options", "Back to options") }}
            </button>

            <form @submit.prevent="handleAuth" class="space-y-4">
              <BaseInput
                v-model="email"
                :label="$t('auth.form.email_label')"
                type="email"
                :placeholder="$t('auth.form.email_placeholder')"
                :error="emailError"
                class="standard-field"
                @blur="validateEmailField"
                :disabled="isLoading"
              />
              <BaseInput
                v-if="!isResettingPassword"
                v-model="password"
                :label="$t('auth.form.password_label')"
                type="password"
                :placeholder="$t('auth.form.password_placeholder')"
                :error="passwordError"
                class="standard-field"
                @blur="validatePasswordField"
                :disabled="isLoading"
              >
                <template
                  v-if="!isRegistering && showForgotButton"
                  #label-right
                >
                  <button
                    @click="triggerResetMode"
                    type="button"
                    :disabled="isLoading"
                    class="text-[11px] font-label text-primary-container hover:underline uppercase font-bold tracking-tighter disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
                  >
                    {{ $t("auth.form.forgot_password") }}
                  </button>
                </template>
                <template v-if="isRegistering" #help-text>
                  <p
                    v-if="!passwordError"
                    class="text-[11px] text-zinc-500 ml-1 italic mt-1.5 leading-tight"
                  >
                    {{ $t("auth.form.password_hint") }}
                  </p>
                </template>
              </BaseInput>

              <button
                type="submit"
                :disabled="
                  isLoading ||
                  !!emailError ||
                  (!isResettingPassword && !!passwordError) ||
                  !email ||
                  (!isResettingPassword && !password)
                "
                class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-3 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-base mt-4 uppercase tracking-widest"
              >
                {{
                  isResettingPassword
                    ? $t("auth.buttons.send_reset")
                    : isRegistering
                      ? $t("auth.buttons.register_identity")
                      : $t("auth.buttons.authenticate")
                }}
              </button>
            </form>
          </div>

          <!-- STATE B: CONTINUE WITH EMAIL BUTTON -->
          <div v-else class="w-full">
            <button
              @click="showEmailForm = true"
              type="button"
              class="flex items-center justify-center w-full bg-surface-container-high hover:bg-surface-container-highest text-on-surface text-xs font-label font-semibold py-3 rounded-xl border border-outline-variant/10 transition-colors shadow-sm active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed gap-2"
            >
              <span class="material-symbols-outlined text-xl opacity-80"
                >mail</span
              >
              {{ $t("auth.buttons.continue_email", "Continue with Email") }}
            </button>
          </div>
        </Transition>
      </section>

      <!-- 2. DIVIDER -->
      <div
        v-if="!isResettingPassword && !showEmailForm"
        class="w-full relative flex items-center py-6"
      >
        <div class="flex-grow border-t border-outline-variant/15"></div>
        <span
          class="flex-shrink mx-4 text-[9px] font-label font-bold text-zinc-500 tracking-[0.4em] uppercase"
        >
          {{ $t("auth.prompts.divider_label") }}
        </span>
        <div class="flex-grow border-t border-outline-variant/15"></div>
      </div>

      <!-- 3. OAUTH BUTTONS (At the top of the interaction zone) -->
      <section
        v-if="!isResettingPassword && !showEmailForm"
        class="w-full space-y-3"
      >
        <button
          @click="handleOAuth('Google')"
          type="button"
          :disabled="isLoading"
          class="flex items-center justify-center w-full bg-[#1e1e1e] hover:bg-[#252525] text-on-surface text-xs font-label font-semibold py-3 rounded-xl border border-outline-variant/10 transition-colors shadow-sm active:scale-[0.98] background-button-custom disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg class="w-5 h-5 mr-3" fill="currentColor" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            ></path>
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            ></path>
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
              fill="#FBBC05"
            ></path>
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 12-4.53z"
              fill="#EA4335"
            ></path>
          </svg>
          {{ $t("auth.buttons.continue_google") }}
        </button>
        <button
          @click="handleOAuth('Apple')"
          :disabled="isLoading"
          class="flex items-center justify-center w-full bg-black text-white hover:bg-zinc-900 text-xs font-label font-semibold py-3 rounded-xl transition-colors shadow-sm active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg class="w-5 h-5 mr-3" fill="currentColor" viewBox="0 0 24 24">
            <path
              d="M17.05 20.28c-.98.95-2.05 1.78-3.3 1.78-1.2 0-1.57-.75-3.04-.75-1.47 0-1.92.73-3.04.75-1.22.02-2.33-.9-3.3-1.8-1.98-1.86-3.5-5.25-3.5-8.43 0-3.15 1.63-4.83 3.19-4.83 1.15 0 2.04.74 2.84.74.78 0 1.9-.84 3.33-.84.9 0 2.13.33 3.04 1.25-.13.1-.9.84-.9 2.22 0 1.67 1.15 2.23 1.38 2.33-.1.3-.43.8-.9 1.43-.53.75-.95 1.4-1.3 1.7zm-2.84-15.82c.6-.74.98-1.74.98-2.73 0-.15-.02-.3-.04-.44-.92.04-2.03.62-2.7 1.4-.53.6-.98 1.62-.98 2.6.14.02.28.03.44.03.88 0 1.78-.45 2.3-1.12z"
            ></path>
          </svg>
          {{ $t("auth.buttons.continue_apple") }}
        </button>
      </section>

      <!-- 4. AUTH TOGGLE MODE (Already have an account? Login) -->
      <div class="w-full mt-6 text-center space-y-2">
        <p
          v-if="!isResettingPassword"
          class="text-xs font-label text-on-surface-variant uppercase tracking-widest"
        >
          {{
            isRegistering
              ? $t("auth.prompts.already_have_account")
              : $t("auth.prompts.dont_have_account")
          }}
        </p>
        <button
          v-if="!isResettingPassword"
          @click="toggleAuthMode"
          type="button"
          :disabled="isLoading"
          class="text-[18px] font-headline font-bold text-primary-container hover:text-primary underline underline-offset-4 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
        >
          {{
            isRegistering
              ? $t("auth.prompts.login_link")
              : $t("auth.prompts.registration_link")
          }}
        </button>

        <button
          v-if="isResettingPassword"
          @click="cancelResetMode"
          :disabled="isLoading"
          class="text-xs font-label mt-2 text-on-surface-variant hover:text-white transition-colors uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ $t("auth.buttons.back_to_login") }}
        </button>
      </div>

      <!-- 5. FOOTER -->
      <footer class="mt-8 text-center w-full">
        <p
          class="text-[10px] text-zinc-500 font-label uppercase tracking-[0.4em] mb-2 font-bold opacity-70"
        >
          {{ $t("auth.footer.encryption_label") }}
        </p>
        <div
          class="flex justify-center space-x-8 text-[11px] text-on-surface-variant font-bold font-label"
        >
          <a
            href="#"
            :class="{ 'pointer-events-none opacity-50': isLoading }"
            class="hover:text-primary transition-all duration-300"
            @click.prevent="activeModal = 'terms'"
            >{{ $t("auth.footer.terms") }}</a
          >
          <a
            href="#"
            :class="{ 'pointer-events-none opacity-50': isLoading }"
            class="hover:text-primary transition-all duration-300"
            @click.prevent="activeModal = 'privacy'"
            >{{ $t("auth.footer.privacy") }}</a
          >
          <a
            href="#"
            :class="{ 'pointer-events-none opacity-50': isLoading }"
            class="hover:text-primary transition-all duration-300"
            @click.prevent="activeModal = 'help'"
            >{{ $t("auth.footer.help") }}</a
          >
        </div>
      </footer>
    </main>

    <!-- MODALS SECTION -->
    <div
      v-if="activeModal"
      class="fixed inset-0 z-[110] flex items-center justify-center px-4"
    >
      <div
        @click="activeModal = null"
        class="absolute inset-0 bg-background/80 backdrop-blur-md"
      ></div>
      <div
        class="relative bg-surface-container-high border border-outline-variant/30 rounded-3xl p-8 max-w-sm w-full shadow-2xl"
      >
        <button
          @click="activeModal = null"
          class="absolute top-5 right-5 text-on-surface-variant hover:text-primary transition-colors"
        >
          <span class="material-symbols-outlined text-2xl">close</span>
        </button>
        <div v-if="activeModal === 'terms'" class="space-y-4 text-left">
          <h3
            class="font-headline text-2xl font-bold text-primary-container uppercase tracking-tight"
          >
            {{ $t("auth.modal.terms_title") }}
          </h3>
          <div
            class="max-h-64 overflow-y-auto pr-2 text-sm text-on-surface-variant leading-relaxed font-body space-y-3"
          >
            <p>{{ $t("auth.modal.terms_p1") }}</p>
            <p>{{ $t("auth.modal.terms_p2") }}</p>
          </div>
        </div>
        <div v-if="activeModal === 'privacy'" class="space-y-4 text-left">
          <h3
            class="font-headline text-2xl font-bold text-primary-container uppercase tracking-tight"
          >
            {{ $t("auth.modal.privacy_title") }}
          </h3>
          <div
            class="max-h-64 overflow-y-auto pr-2 text-sm text-on-surface-variant leading-relaxed font-body space-y-3"
          >
            <p>{{ $t("auth.modal.privacy_p1") }}</p>
            <p>{{ $t("auth.modal.privacy_p2") }}</p>
          </div>
        </div>
        <div v-if="activeModal === 'help'" class="space-y-4 text-left">
          <h3
            class="font-headline text-2xl font-bold text-primary-container uppercase tracking-tight"
          >
            {{ $t("auth.modal.help_title") }}
          </h3>
          <div
            class="max-h-64 overflow-y-auto pr-2 text-sm text-on-surface-variant leading-relaxed font-body space-y-3"
          >
            <p>{{ $t("auth.modal.help_p1") }}</p>
            <p>{{ $t("auth.modal.help_p2") }}</p>
          </div>
        </div>
        <button
          @click="activeModal = null"
          class="w-full mt-8 py-4 bg-primary-container text-on-primary-container font-headline font-bold rounded-xl active:scale-95 transition-all uppercase tracking-[0.2em] text-xs"
        >
          {{ $t("auth.modal.acknowledge") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useHead } from "#imports";
import { useAuthStore } from "~/stores/auth";
import { $api } from "~/utils/api";

const authStore = useAuthStore();
const navigate = useSovereignNavigate();
const localePath = useLocalePath();

type AvailableLocales = "en" | "hu" | "fr" | "de" | "pl" | "es";
const { t, setLocale, locale } = useI18n();

useHead({
  script: [
    { src: "https://accounts.google.com/gsi/client", async: true, defer: true },
    {
      src: "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js",
      async: true,
      defer: true,
    },
  ],
});

/** ANCHOR UI-STATES */
const activeLanguage = ref<AvailableLocales>("en");
const isLanguageReady = ref(false);
const isRegistering = ref(false);
const isResettingPassword = ref(false);
const isLoading = ref(false);
const showForgotButton = ref(false);
const activeModal = ref<null | "terms" | "privacy" | "help">(null);
const resetSuccessMessage = ref("");

// NEW STATE: Controls the visibility of the Email & Password inputs
const showEmailForm = ref(false);

/** ANCHOR FORM-MODELS */
const email = ref("");
const password = ref("");
const emailError = ref("");
const passwordError = ref("");

// Helper a backend/store hibaüzenetek dinamikus fordításához
const parseApiMessage = (
  msg: string | null | undefined,
  fallbackText: string,
) => {
  if (!msg) return fallbackText;
  return msg.startsWith("api_errors.") ? t(msg) : msg;
};

/** ANCHOR VALIDATION */
const validateEmailField = () => {
  if (!email.value) {
    emailError.value = "";
    return false;
  }
  const regex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!regex.test(email.value)) {
    emailError.value = t("auth.validation.invalid_email");
    return false;
  }
  emailError.value = "";
  return true;
};

const validatePasswordField = () => {
  passwordError.value = "";
  if (!password.value) return false;

  if (password.value.length < 12) {
    passwordError.value = t("auth.validation.password_too_short");
    return false;
  }
  if (!/[A-Z]/.test(password.value)) {
    passwordError.value = t("auth.validation.password_no_uppercase");
    return false;
  }
  if (!/[a-z]/.test(password.value)) {
    passwordError.value = t("auth.validation.password_no_lowercase");
    return false;
  }
  if (!/[0-9]/.test(password.value)) {
    passwordError.value = t("auth.validation.password_no_number");
    return false;
  }
  if (!/[!@#$%^&*(),.?":{}|<>\-_+=\[\]\/\\'`~]/.test(password.value)) {
    passwordError.value = t("auth.validation.password_no_special");
    return false;
  }

  return true;
};

watch(email, () => validateEmailField());

watch(password, () => {
  validatePasswordField();
  if (!isRegistering.value) {
    validateEmailField();
  }
});

onMounted(() => {
  // Uses existing logic: Defaults to Register if they haven't visited before
  if (localStorage.getItem("nusift_visited")) {
    isRegistering.value = false;
  } else {
    isRegistering.value = true;
  }

  const savedLang = localStorage.getItem("nusift_preferred_language");
  if (savedLang) {
    activeLanguage.value = savedLang as AvailableLocales;
    setLocale(savedLang as AvailableLocales);
    isLanguageReady.value = true;
  }
});

const toggleAuthMode = () => {
  isRegistering.value = !isRegistering.value;
  isResettingPassword.value = false;
  resetSuccessMessage.value = "";
  email.value = "";
  password.value = "";
  emailError.value = "";
  passwordError.value = "";
  showForgotButton.value = false;
  // NOTE: We do not set showEmailForm to false here.
  // If they are in the email form, let them stay in the email form.
};

const triggerResetMode = () => {
  isResettingPassword.value = true;
  isRegistering.value = false;
  resetSuccessMessage.value = "";
  passwordError.value = "";
  email.value = "";
  emailError.value = "";
  showEmailForm.value = true; // Ensure the form is forced open
};

const cancelResetMode = () => {
  isResettingPassword.value = false;
  resetSuccessMessage.value = "";
  emailError.value = "";
  showEmailForm.value = false; // Collapse back to social buttons
};

/** ANCHOR HANDLERS */
const handleLanguageSelection = (langCode: string) => {
  activeLanguage.value = langCode as AvailableLocales;
  setLocale(langCode as AvailableLocales);
  isLanguageReady.value = true;
};

const handleAuth = async () => {
  const eValid = validateEmailField();
  if (!eValid) return;

  if (isResettingPassword.value) {
    isLoading.value = true;
    try {
      const response = await $api<any>("/api/auth/forgot-password", {
        method: "POST",
        body: { email: email.value },
      });
      resetSuccessMessage.value = response.message;
      emailError.value = "";
    } catch (error: any) {
      emailError.value = parseApiMessage(
        error.response?._data?.normalizedMessage || error.data?.statusMessage,
        t("auth.errors.request_failed"),
      );
    } finally {
      isLoading.value = false;
    }
    return;
  }

  const pValid = validatePasswordField();
  if (!pValid) return;

  isLoading.value = true;
  emailError.value = "";
  passwordError.value = "";

  if (isRegistering.value) {
    const success = await authStore.registerIdentity(
      email.value,
      password.value,
      activeLanguage.value,
    );
    if (success) {
      //   localStorage.setItem("nusift_visited", "true");
      //   localStorage.setItem("nusift_pending_email", email.value);

      const targetLang = activeLanguage.value as AvailableLocales;
      if (locale.value !== targetLang) {
        try {
          await setLocale(targetLang);
        } catch (e) {}
      }

      const verifyRoute = localePath(
        { name: "verify-email-custom" },
        targetLang,
      );
      return navigateTo(verifyRoute);
    } else {
      emailError.value = parseApiMessage(
        authStore.authError,
        t("auth.errors.registration_failed"),
      );
      isLoading.value = false;
      showForgotButton.value = true;
    }
  } else {
    const success = await authStore.loginIdentity(email.value, password.value);
    if (success) {
      //   localStorage.setItem("nusift_visited", "true");

      const targetLang = (authStore.user?.preferredLanguage ||
        activeLanguage.value) as AvailableLocales;
      if (locale.value !== targetLang) {
        try {
          await setLocale(targetLang);
        } catch (e) {}
      }

      const dashboardRoute = localePath(
        { name: "dashboard-custom" },
        targetLang,
      );
      const preloaderRoute = localePath(
        { name: "preloader-custom" },
        targetLang,
      );

      if (
        authStore.user?.onboardingStep !== undefined &&
        authStore.user.onboardingStep >= 3
      ) {
        return navigateTo(dashboardRoute);
      } else {
        return navigateTo(preloaderRoute);
      }
    } else {
      if (authStore.authError === "UNVERIFIED_ACCOUNT") {
        // localStorage.setItem("nusift_pending_email", email.value);
        const targetLang = activeLanguage.value as AvailableLocales;
        if (locale.value !== targetLang) {
          try {
            await setLocale(targetLang);
          } catch (e) {}
        }
        const verifyRoute = localePath(
          { name: "verify-email-custom" },
          targetLang,
        );
        return navigateTo(verifyRoute);
      }

      emailError.value = parseApiMessage(
        authStore.authError,
        t("auth.errors.auth_failure"),
      );
      showForgotButton.value = true;
      isLoading.value = false;
    }
  }
};

/** ANCHOR OAUTH-LOGIC */
const handleOAuth = async (provider: string) => {
  isLoading.value = true;
  emailError.value = "";

  const OAUTH_TIMEOUT_MS = 30000;
  let safetyTimer: NodeJS.Timeout | null = null;

  const clearSafetyTimer = () => {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  };

  try {
    if (provider === "Google") {
      const config = useRuntimeConfig();
      const googleId = config.public.googleClientId;

      if (!googleId) {
        throw new Error(t("auth.errors.oauth_missing_id"));
      }

      if (!(window as any).google?.accounts?.oauth2) {
        throw new Error(t("auth.errors.oauth_not_init"));
      }

      const client = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: googleId,
        scope: "email profile",
        callback: async (response: any) => {
          clearSafetyTimer();
          if (response.error) {
            isLoading.value = false;
            if (response.error === "access_denied") {
              emailError.value = t("auth.errors.oauth_cancelled");
              return;
            }
            throw new Error(response.error);
          }
          await processOAuthLogin(response.access_token, "GOOGLE");
        },
      });

      safetyTimer = setTimeout(() => {
        if (isLoading.value) {
          isLoading.value = false;
          emailError.value = t("auth.errors.oauth_timeout");
          console.warn("OAuth Handshake Timed Out.");
        }
      }, OAUTH_TIMEOUT_MS);

      client.requestAccessToken();
    } else if (provider === "Apple") {
      (window as any).AppleID.auth.init({
        clientId: "com.yourdomain.nusift",
        scope: "email name",
        redirectURI: "https://nusift.io/api/auth/apple/callback",
        usePopup: true,
      });

      const response = await (window as any).AppleID.auth.signIn();
      await processOAuthLogin(response.authorization.id_token, "APPLE");
    }
  } catch (error: any) {
    clearSafetyTimer();
    console.error(`${provider} OAuth Error:`, error);
    emailError.value = t("auth.errors.oauth_failed", { provider });
    isLoading.value = false;
  }
};

const processOAuthLogin = async (rawToken: string, providerName: string) => {
  const success = await authStore.oauthIdentity(
    rawToken,
    providerName,
    activeLanguage.value,
  );

  if (success) {
    // Persistent flag for future sessions
    localStorage.setItem("nusift_visited", "true");

    // Sync the live reactive state for the current SPA session
    isRegistering.value = false;

    const targetLang = (authStore.user?.preferredLanguage ||
      activeLanguage.value) as AvailableLocales;

    if (locale.value !== targetLang) {
      try {
        await setLocale(targetLang);
      } catch (e) {
        // Intentionally left blank to swallow Vue Router cancellation warnings
      }
    }

    const dashboardRoute = localePath({ name: "dashboard-custom" }, targetLang);
    const preloaderRoute = localePath({ name: "preloader-custom" }, targetLang);

    if (
      authStore.user?.onboardingStep !== undefined &&
      authStore.user.onboardingStep >= 3
    ) {
      return navigateTo(dashboardRoute);
    } else {
      return navigateTo(preloaderRoute);
    }
  } else {
    emailError.value = parseApiMessage(
      authStore.authError,
      t("auth.errors.handshake_failed", { provider: providerName }),
    );
    isLoading.value = false;
  }
};
</script>

<style scoped>
.background-button-custom {
  background: linear-gradient(
    135deg,
    rgba(80, 80, 80, 0.8) 0%,
    rgba(121, 121, 121, 0.6) 100%
  ) !important;
}

/* UI Transitions for Progressive Disclosure */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
