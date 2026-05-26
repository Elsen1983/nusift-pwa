<!-- pages/verifyEmail/verify-email.vue -->
<template>
  <div
    class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container/30 relative overflow-hidden"
  >
    <div
      v-if="isLoading"
      class="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background/90 backdrop-blur-md"
    >
      <div class="relative flex items-center justify-center mb-6">
        <div
          class="absolute w-16 h-16 border-4 border-primary/20 rounded-full"
        ></div>
        <div
          class="absolute w-16 h-16 border-4 border-t-primary rounded-full animate-spin"
        ></div>
        <span
          class="material-symbols-outlined text-primary text-3xl animate-pulse"
          >sync</span
        >
      </div>
      <p
        class="font-headline text-lg font-medium tracking-wide text-on-surface"
      >
        {{ loadingText }}
      </p>
    </div>

    <main
      class="min-h-screen flex flex-col items-center justify-center px-6 py-12 relative overflow-hidden"
    >
      <div
        class="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-surface-tint/5 rounded-full blur-[120px] -z-10"
      ></div>

      <div
        class="w-full max-w-md flex flex-col items-center text-center relative z-10"
      >
        <div class="relative w-[120px] h-[120px] mb-12 mx-auto">
          <div
            class="absolute inset-0 bg-primary-container/10 blur-2xl rounded-full"
          ></div>
          <div
            class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl shadow-2xl"
          >
            <img
              alt="NuSift logo"
              class="w-full h-full object-cover"
              src="~/assets/images/NuSift_Logo_Blue.png"
            />
          </div>
        </div>

        <div class="space-y-4 mb-5">
          <h1 class="font-lg text-4xl font-bold tracking-tight text-on-surface">
            {{ $t('verifyEmail.title') }}
          </h1>
          <p
            class="font-body text-medium text-on-surface-variant leading-relaxed max-w-sm mx-auto px-2"
          >
            {{ $t('verifyEmail.description') }}
          </p>
        </div>

        <div
          class="flex items-center justify-center gap-3 mb-8 py-2 px-2 rounded-full bg-surface-container-low border border-outline-variant/10"
        >
          <div class="relative flex h-3 w-3">
            <div
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"
            ></div>
            <div
              class="relative inline-flex rounded-full h-3 w-3 bg-primary"
            ></div>
          </div>
          <span
            class="text-sm font-label font-medium text-on-surface-variant tracking-wide"
            >{{ $t('verifyEmail.awaiting') }}</span>
        </div>

        <div class="w-full space-y-6">
          <div class="space-y-3">
            <p
              class="text-[10px] text-outline font-label font-bold uppercase tracking-[0.2em]"
            >
              {{ $t('verifyEmail.fallback_title') }}
            </p>

            <transition name="fade">
              <p
                v-if="errorMsg"
                class="text-error text-xs font-label bg-error/10 border border-error/20 rounded-lg p-3 text-red-400"
              >
                {{ errorMsg }}
              </p>
            </transition>
            <transition name="fade">
              <p
                v-if="successMsg"
                class="text-green-400 text-xs font-label bg-green-400/10 border border-green-400/20 rounded-lg p-3"
              >
                {{ successMsg }}
              </p>
            </transition>

            <!-- A gomb marad aktív, mint biztonsági háló! -->
            <button
              @click="handleManualVerification"
              :disabled="isLoading"
              class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-4 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-base mt-4 uppercase tracking-widest"
            >
              {{ $t('verifyEmail.buttons.verified_login') }}
            </button>
          </div>

          <div class="pt-1">
            <button
              @click="resendEmail"
              :disabled="isLoading || resendCooldown > 0"
              class="font-label text-sm font-medium text-on-surface-variant hover:text-primary transition-colors py-2 px-4 rounded-lg hover:bg-surface-bright/20 flex items-center justify-center gap-2 mx-auto disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span class="material-symbols-outlined text-[18px]">refresh</span>
              {{
                resendCooldown > 0
                  ? $t('verifyEmail.buttons.resend_wait', { seconds: resendCooldown })
                  : $t('verifyEmail.buttons.resend')
              }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useCookie } from "nuxt/app";
import { $api } from "~/utils/api";

type AvailableLocales = "en" | "hu" | "fr" | "de" | "pl" | "es";
const { t, setLocale } = useI18n();
const navigate = useSovereignNavigate();
const isLoading = ref(false);
const loadingText = ref(t('verifyEmail.loading.syncing'));
const errorMsg = ref("");
const successMsg = ref("");
const resendCooldown = ref(0);

let pollingInterval: NodeJS.Timeout | null = null;

// 1. ANCHOR: ROBUST COOKIE DETECTION
// Use Nuxt's built-in composable instead of raw document.cookie parsing.
// This guarantees we are reading the actual parsed cookie value safely.
const sessionCookie = useCookie('session_status');

const checkSessionActive = () => {
  console.log("[Verification Protocol] Current session status:", sessionCookie.value);
  return sessionCookie.value === 'active';
};

onMounted(() => {
  console.log("Checking for saved language preference...");
  const savedLang = localStorage.getItem('nusift_preferred_language');
  if (savedLang) {
    setLocale(savedLang as AvailableLocales);
    loadingText.value = t('verifyEmail.loading.syncing'); 
    console.log(`Language set to ${savedLang} based on saved preference.`);
  } else{
    console.warn("No saved language preference found. Defaulting to English.");
  }

  // 2. ANCHOR: THE POLLING INTERVAL
  pollingInterval = setInterval(() => {
    // We now use the reactive Nuxt cookie checker
    if (checkSessionActive()) {
      console.log("Verification confirmed via Nuxt cookie check. Redirecting...");
      if (pollingInterval) clearInterval(pollingInterval);
      isLoading.value = true;
      loadingText.value = t('verifyEmail.loading.confirmed');
      setTimeout(() => {
        if (checkSessionActive()) {
          navigate.hardRedirect("/preloader-page");
        } else {
          successMsg.value = t('verifyEmail.messages.check_email') || t('verifyEmail.messages.session_expired') || 'Verification pending. Please check your email.';
        }
      }, 1500);
    }
  }, 1500);
});

// Clear interval on unmount to prevent memory leaks
onUnmounted(() => {
  if (pollingInterval) clearInterval(pollingInterval);
  console.warn("Verification component unmounted, polling stopped.");
});

const handleManualVerification = async () => {
  isLoading.value = true;
  loadingText.value = t('verifyEmail.loading.verifying');
  errorMsg.value = "";
  successMsg.value = "";

  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.warn("Manual verification triggered by user. Checking session cookie status...");

  // Use the robust check here too
  if (checkSessionActive()) {
    console.warn("Manual verification successful. Redirecting to secure login...");
    isLoading.value = false;
    navigate.hardRedirect("/"); 
  } else {
    isLoading.value = false;
    localStorage.setItem("nusift_visited", "true");
    localStorage.removeItem("nusift_pending_email");
    successMsg.value = t('verifyEmail.messages.manual_check');
    console.warn("Manual verification attempted, but session cookie is not active. User may need to check their email or wait a moment before trying again.");
    console.log(t('verifyEmail.messages.manual_check'));

    setTimeout(() => {
      // window.location.href = "/";
      navigate.hardRedirect("/preloader-page"); // This will trigger a full page reload, ensuring the new session cookie is recognized immediately 
    }, 3000);
  }
};

const resendEmail = async () => {
  errorMsg.value = "";
  successMsg.value = "";

  // Ezt a regisztrációkor kell beállítanod az Auth oldalon! (Lásd 4-es pont)
  const pendingEmail = localStorage.getItem("nusift_pending_email");

  if (!pendingEmail) {
    errorMsg.value = t('verifyEmail.messages.session_expired');
    return;
  }

  isLoading.value = true;
  loadingText.value = t('verifyEmail.loading.dispatching');

  try {
    const response = await $api("/api/auth/resend", {
      method: "POST",
      body: { email: pendingEmail },
    });

    successMsg.value = t('verifyEmail.messages.resend_success');

    // Cooldown védelem a spam ellen (60 másodperc)
    resendCooldown.value = 60;
    const cooldownTimer = setInterval(() => {
      resendCooldown.value--;
      if (resendCooldown.value <= 0) clearInterval(cooldownTimer);
    }, 1000);
  } catch (error: any) {
    errorMsg.value =
      error.statusMessage || t('verifyEmail.messages.resend_error');
  } finally {
    isLoading.value = false;
  }
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
