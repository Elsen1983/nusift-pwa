<template>
  <div
    class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container relative overflow-hidden"
  >
    <ClientOnly>
      <PwaInstallBanner />
    </ClientOnly>

    <!-- Loading Overlay -->
    <div
      v-if="isLoading"
      class="fixed inset-0 backdrop-blur-sm bg-surface/80 z-[100] flex flex-col items-center justify-center"
    >
      <div class="relative w-16 h-16 mb-6">
        <div class="absolute inset-0 rounded-full border-4 border-primary-container/20"></div>
        <div class="absolute inset-0 rounded-full border-4 border-t-primary-container animate-spin"></div>
      </div>
      <p class="font-label text-sm text-on-surface tracking-widest uppercase animate-pulse text-center px-6">
        {{ isRegistering ? "Forging Sovereign Identity..." : "Initializing Secure Handshake..." }}
      </p>
    </div>

    <!-- Background Accents -->
    <div class="fixed top-[-5%] left-[-5%] w-[40%] h-[30%] bg-primary-container/5 blur-[100px] rounded-full -z-10 pointer-events-none"></div>
    <div class="fixed bottom-[0%] right-[-5%] w-[30%] h-[25%] bg-secondary-container/5 blur-[80px] rounded-full -z-10 pointer-events-none"></div>

    <main class="min-h-screen flex flex-col items-center justify-center px-8 py-6 max-w-md mx-auto relative z-10">
      <section class="w-full flex flex-col items-center mb-6">
        <div class="relative w-[125px] h-[125px] mb-4 shadow-xl rounded-xl">
          <div class="absolute inset-0 bg-primary-container/10 blur-xl rounded-full"></div>
          <div class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl shadow-2xl">
            <img src="~/assets/images/NuSift_Logo_Blue.png" alt="NuSift Logo" class="w-full h-full object-cover" />
          </div>
        </div>
        <h1 class="font-headline text-3xl font-bold tracking-tight text-on-surface text-center transition-all duration-500">
          {{ isRegistering ? "Registration" : "Welcome Back" }}
        </h1>
        <p class="text-[11px] text-on-surface-variant mt-2 font-label uppercase tracking-[0.25em] text-center opacity-80">
          {{ isRegistering ? "Neural Node Creation" : "Horizon Feed Access" }}
        </p>
      </section>

      <section class="w-full">
        <form @submit.prevent="handleAuth" class="space-y-4">
          <BaseInput
            v-model="email"
            label="Email Address"
            type="email"
            placeholder="engineer@company.com"
            :error="emailError"
            class="standard-field"
            @blur="validateEmailField"
          />

          <BaseInput
            v-model="password"
            label="Password"
            type="password"
            placeholder="••••••••••••"
            :error="passwordError"
            class="standard-field"
            @blur="validatePasswordField"
          >
            <template v-if="!isRegistering && showForgotButton" #label-right>
              <button type="button" class="text-[11px] font-label text-primary-container hover:underline uppercase font-bold tracking-tighter">
                Forgot?
              </button>
            </template>
            <template v-if="isRegistering" #help-text>
              <p v-if="!passwordError" class="text-[11px] text-zinc-500 ml-1 italic mt-1.5 leading-tight">
                Min 12 characters, mix of cases and symbols.
              </p>
            </template>
          </BaseInput>

          <button
            type="submit"
            :disabled="isLoading || !!emailError || !!passwordError || !email || !password"
            class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-4 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-base mt-4 uppercase tracking-widest"
          >
            {{ isRegistering ? "Register Identity" : "Authenticate" }}
          </button>
        </form>

        <div class="mt-8 text-center space-y-2">
          <p class="text-xs font-label text-on-surface-variant uppercase tracking-widest">
            {{ isRegistering ? "Already have an account?" : "Don't have a node yet?" }}
          </p>
          <button @click="toggleAuthMode" type="button" class="text-sm font-headline font-bold text-primary-container hover:text-primary underline underline-offset-4 transition-colors">
            {{ isRegistering ? "Login" : "Register Identity" }}
          </button>
        </div>

        <div class="relative flex items-center py-5">
          <div class="flex-grow border-t border-outline-variant/15"></div>
          <span class="flex-shrink mx-4 text-[9px] font-label font-bold text-zinc-500 tracking-[0.4em] uppercase">Social Gate</span>
          <div class="flex-grow border-t border-outline-variant/15"></div>
        </div>
      </section>

      <section class="w-full space-y-3">
        <button @click="handleOAuth('Google')" type="button" class="flex items-center justify-center w-full bg-[#1e1e1e] hover:bg-[#252525] text-on-surface text-xs font-label font-semibold py-3 rounded-xl border border-outline-variant/10 transition-colors shadow-sm active:scale-[0.98]">
          <svg class="w-5 h-5 mr-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"></path>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"></path>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"></path>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 12-4.53z" fill="#EA4335"></path>
          </svg>
          Continue with Google
        </button>
        <button @click="handleOAuth('Apple')" type="button" class="flex items-center justify-center w-full bg-black text-white hover:bg-zinc-900 text-xs font-label font-semibold py-3 rounded-xl transition-colors shadow-sm active:scale-[0.98]">
          <svg class="w-5 h-5 mr-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.05 20.28c-.98.95-2.05 1.78-3.3 1.78-1.2 0-1.57-.75-3.04-.75-1.47 0-1.92.73-3.04.75-1.22.02-2.33-.9-3.3-1.8-1.98-1.86-3.5-5.25-3.5-8.43 0-3.15 1.63-4.83 3.19-4.83 1.15 0 2.04.74 2.84.74.78 0 1.9-.84 3.33-.84.9 0 2.13.33 3.04 1.25-.13.1-.9.84-.9 2.22 0 1.67 1.15 2.23 1.38 2.33-.1.3-.43.8-.9 1.43-.53.75-.95 1.4-1.3 1.7zm-2.84-15.82c.6-.74.98-1.74.98-2.73 0-.15-.02-.3-.04-.44-.92.04-2.03.62-2.7 1.4-.53.6-.98 1.62-.98 2.6.14.02.28.03.44.03.88 0 1.78-.45 2.3-1.12z"></path>
          </svg>
          Continue with Apple
        </button>
      </section>

      <footer class="mt-8 text-center w-full">
        <p class="text-[10px] text-zinc-500 font-label uppercase tracking-[0.4em] mb-2 font-bold opacity-70">
          Sovereign-Grade Encryption
        </p>
        <div class="flex justify-center space-x-8 text-[11px] text-on-surface-variant font-bold font-label">
          <a href="#" @click.prevent="activeModal = 'terms'" class="hover:text-primary transition-all duration-300">Terms</a>
          <a href="#" @click.prevent="activeModal = 'privacy'" class="hover:text-primary transition-all duration-300">Privacy</a>
          <a href="#" @click.prevent="activeModal = 'help'" class="hover:text-primary transition-all duration-300">Help</a>
        </div>
      </footer>
    </main>

    <!-- Modals -->
    <div v-if="activeModal" class="fixed inset-0 z-[110] flex items-center justify-center px-4">
      <div @click="activeModal = null" class="absolute inset-0 bg-background/80 backdrop-blur-md"></div>
      <div class="relative bg-surface-container-high border border-outline-variant/30 rounded-3xl p-8 max-w-sm w-full shadow-2xl">
        <button @click="activeModal = null" class="absolute top-5 right-5 text-on-surface-variant hover:text-primary transition-colors">
          <span class="material-symbols-outlined text-2xl">close</span>
        </button>
        <div v-if="activeModal === 'terms'" class="space-y-4 text-left">
          <h3 class="font-headline text-2xl font-bold text-primary-container uppercase tracking-tight">Terms of Sovereignty</h3>
          <div class="max-h-64 overflow-y-auto pr-2 text-sm text-on-surface-variant leading-relaxed font-body space-y-3">
            <p>By initializing this node, you agree to the decentralized governance protocols of NuSift.</p>
            <p>User data is encrypted locally; NuSift never holds your private keys.</p>
          </div>
        </div>
        <!-- ... other modals ... -->
        <button @click="activeModal = null" class="w-full mt-8 py-4 bg-primary-container text-on-primary-container font-headline font-bold rounded-xl active:scale-95 transition-all uppercase tracking-[0.2em] text-xs">
          Acknowledge
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useRouter } from "nuxt/app";
import { useHead } from "#imports";
import { useAuthStore } from "~/stores/auth";

const authStore = useAuthStore();
const router = useRouter();

/** ANCHOR SDK-INJECTION */
useHead({
  script: [
    { src: 'https://accounts.google.com/gsi/client', async: true, defer: true },
    { src: 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js', async: true, defer: true }
  ]
});

/** ANCHOR UTILS */
const decodeJwt = (token: string) => {
  try {
    const parts = token.split('.');
    const base64Url = parts[1];
    if (!base64Url) return null; // FIX: Handle possible undefined
    
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
};

/** ANCHOR UI-STATES */
const isRegistering = ref(false);
const isLoading = ref(false);
const showForgotButton = ref(false);
const activeModal = ref<null | "terms" | "privacy" | "help">(null);

/** ANCHOR FORM-MODELS */
const email = ref("");
const password = ref("");
const emailError = ref("");
const passwordError = ref("");

/** ANCHOR VALIDATION */
const validateEmailField = () => {
  if (!email.value) {
    emailError.value = "";
    return false;
  }
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!regex.test(email.value)) {
    emailError.value = "Invalid identity format.";
    return false;
  }
  emailError.value = "";
  return true;
};

const validatePasswordField = () => {
  passwordError.value = "";
  if (!password.value) return false;
  if (password.value.length < 12) {
    passwordError.value = "Security fail: Minimum 12 characters.";
    return false;
  }
  return true;
};

watch(email, () => validateEmailField());
watch(password, () => validatePasswordField());

onMounted(() => {
  if (!localStorage.getItem("nusift_visited")) isRegistering.value = true;
});

const toggleAuthMode = () => {
  isRegistering.value = !isRegistering.value;
  email.value = "";
  password.value = "";
  emailError.value = "";
  passwordError.value = "";
  showForgotButton.value = false;
};

/** ANCHOR HANDLERS */
const handleAuth = async () => {
  const eValid = validateEmailField();
  const pValid = validatePasswordField();
  if (!eValid || !pValid) return;

  if (isRegistering.value) {
    const success = await authStore.registerIdentity(email.value, password.value);
    if (success) {
      localStorage.setItem("nusift_visited", "true");
      localStorage.setItem("nusift_pending_email", email.value);
      router.push("/verify-email");
    } else {
      emailError.value = authStore.authError || "An unexpected error occurred.";
    }
  } else {
    const success = await authStore.loginIdentity(email.value, password.value);
    if (success) {
      localStorage.setItem("nusift_visited", "true");
      if (authStore.user?.onboardingStep !== undefined && authStore.user.onboardingStep >= 3) {
        router.push('/dashboard'); 
      } else {
       router.replace('/preloader-page'); 
      }
    } else {
      emailError.value = authStore.authError || "Authentication failure.";
      showForgotButton.value = true;
    }
  }
};

/** ANCHOR OAUTH-LOGIC */
const handleOAuth = async (provider: string) => {
  isLoading.value = true;
  emailError.value = "";

  // 1. Safety Timeout definíció (pl. 30 másodperc)
  const OAUTH_TIMEOUT_MS = 30000;
  let safetyTimer: NodeJS.Timeout | null = null;

  const clearSafetyTimer = () => {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  };

  try {
    if (provider === 'Google') {
      // 2. Runtime config használata (Nuxt módszer)
      const config = useRuntimeConfig();
      // Senior Check: Ensure the ID actually exists before calling the SDK
      const googleId = config.public.googleClientId;

      if (!googleId) {
        throw new Error("Configuration Error: Google Client ID is missing.");
      }

      if (!(window as any).google?.accounts?.oauth2) {
        throw new Error("Handshake failed: Identity provider not initialized yet.");
      }

      const client = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: googleId, // Use the bridged config value
        scope: 'email profile',
        callback: async (response: any) => {
          // CALL #1: Success/Response received. Kill the timer now!
          clearSafetyTimer();

          if (response.error) {
            isLoading.value = false;
            if (response.error === 'access_denied') {
              emailError.value = "Authentication cancelled by user.";
              return;
            }
            throw new Error(response.error);
          }
          await processOAuthLogin(response.access_token, 'GOOGLE');
        }
      });

      safetyTimer = setTimeout(() => {
        if (isLoading.value) {
          isLoading.value = false;
          emailError.value = "The authentication window took too long to respond. Please try again.";
          console.warn("OAuth Handshake Timed Out.");
        }
      }, OAUTH_TIMEOUT_MS);

      client.requestAccessToken();
    } 
    else if (provider === 'Apple') {
      (window as any).AppleID.auth.init({
        clientId: 'com.yourdomain.nusift',
        scope: 'email name',
        redirectURI: 'https://nusift.io/api/auth/apple/callback', 
        usePopup: true
      });

      const response = await (window as any).AppleID.auth.signIn();
      await processOAuthLogin(response.authorization.id_token, 'APPLE');
    }
  } catch (error: any) {
    // CALL #2: Something went wrong. Kill the timer so it doesn't fire later.
    clearSafetyTimer();
    console.error(`${provider} OAuth Error:`, error);
    emailError.value = `Failed to authenticate with ${provider}.`; 
    isLoading.value = false;
  }
};

const processOAuthLogin = async (rawToken: string, providerName: string) => {
  // Ensure the store action is called with only 2 arguments as per the new backend
  const success = await authStore.oauthIdentity(rawToken, providerName);

  if (success) {
    localStorage.setItem("nusift_visited", "true");
    if (authStore.user?.onboardingStep !== undefined && authStore.user.onboardingStep >= 3) {
      router.push('/dashboard'); 
    } else {
      router.replace('/preloader-page'); 
    }
  } else {
    emailError.value = authStore.authError || `${providerName} handshake failed.`;
    isLoading.value = false;
  }
};
</script>