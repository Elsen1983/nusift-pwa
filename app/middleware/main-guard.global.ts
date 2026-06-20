/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard (Sovereign Shield 6.1 - Ghost State Prevention)
 */
import { useAuthStore } from "~/stores/auth";

export default defineNuxtRouteMiddleware(async (to, from) => {
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";
  const REGION_CALIBRATION = "/region-calibration";
  const SOURCE_CALIBRATION = "/source-calibration";
  const INTEREST_CALIBRATION = "/interest-calibration";
  const DASHBOARD_PATH = "/dashboard";

  const authStore = useAuthStore();
  const tokenCookie = useCookie("auth_token");
  const localePath = useLocalePath();

  // 1. ANCHOR: i18n PATH NORMALIZATION
  // Strip the language prefix (e.g., '/hu', '/en') so the guard logic works universally
  const cleanPath = to.path.replace(/^\/(en|hu|fr|de|pl|es)(?=\/|$)/, '') || '/';
  const PUBLIC_ROUTES = [AUTH_PATH, "/verify-email", "/verify", "/reset-password"];
  // 2. Use cleanPath instead of to.path
  const isPublicRoute = PUBLIC_ROUTES.includes(cleanPath);

  

  // On server: check auth_token cookie. On client: check if auth store has user data.
  // session_status is now httpOnly and unreadable by client JS.
  let hasActiveSession = import.meta.server ? !!tokenCookie.value : !!authStore.user;

// ==========================================
  // ANCHOR RUNTIME ZOMBIE CHECK (CLIENT ONLY)
  // ==========================================
  // This executes strictly in the user's browser during navigation.
  // It completely bypasses the Nuxt SSR engine, eliminating any risk of OOM deadlocks.
  if (import.meta.client && hasActiveSession && !isPublicRoute) {
    try {
      // Pointing to your existing validation endpoint
      await $fetch('/api/auth/user-validate');
    } catch (error: any) {
      // Pass the 'error' object to the console logger to satisfy SonarQube
      console.warn("Sovereign Shield: Active session rejected by authority. Forcing eviction.", error);
      
      tokenCookie.value = null;
      hasActiveSession = false;
      authStore.$reset();
      
      return navigateTo(AUTH_PATH, { replace: true });
    }
  }
  // 2. ANCHOR SYNC-CHECK (Ghost State Prevention)
  if (!hasActiveSession && authStore.user !== null) {
    authStore.$reset();
  }

  const isAuthenticated = authStore.user !== null && hasActiveSession;
  const currentStep = authStore.user?.onboardingStep || 0;

 // Define the exact literal types allowed by your i18n config
  type AvailableLocales = "en" | "hu" | "fr" | "de" | "pl" | "es";
  
  // Cast the extracted string to the strict type
  const userLang = (authStore.user?.preferredLanguage || 'en') as AvailableLocales;

  const getOnboardingTarget = (step: number) => {
    switch (step) {
      case 0: return REGION_CALIBRATION;
      case 1: return SOURCE_CALIBRATION;
      case 2: return INTEREST_CALIBRATION;
      default: return DASHBOARD_PATH;
    }
  };

  const targetPath = getOnboardingTarget(currentStep);

  // 4. ANCHOR REDIRECT-LOGIC (Tightened)
  
  // If authenticated, NEVER allow access to /auth - send to current onboarding step or dashboard
  if (isAuthenticated && cleanPath === AUTH_PATH) {
    return navigateTo(localePath(targetPath, userLang));
  }

  // Handle Root Path
  if (cleanPath === ROOT_PATH) {
    return navigateTo(localePath(isAuthenticated ? targetPath : AUTH_PATH, userLang));
  }

  // Protect private routes
  if (!isAuthenticated && !isPublicRoute) {
    return navigateTo(localePath(AUTH_PATH, userLang), { replace: true });
  }

  // --- Onboarding Flow Lockdown ---
  const LOCKED_ONBOARDING_ROUTES = [
    "/preloader-page",
    "/region-calibration",
    "/source-calibration",
    "/interest-calibration",
  ];

  const ALL_TRANSITIONAL_ROUTES = [
    ...LOCKED_ONBOARDING_ROUTES,
    "/initialization-preloader-page",
    "/dashboard-initiate",
  ];

  const isFullyOnboarded = currentStep >= 3;

  if (isFullyOnboarded && LOCKED_ONBOARDING_ROUTES.includes(cleanPath)) {
    return navigateTo(localePath(DASHBOARD_PATH, userLang), { replace: true });
  }

  if (
    isAuthenticated &&
    !isFullyOnboarded &&
    cleanPath !== targetPath &&
    !isPublicRoute &&
    cleanPath !== DASHBOARD_PATH &&
    !ALL_TRANSITIONAL_ROUTES.includes(cleanPath)
  ) {
    return navigateTo(localePath(targetPath, userLang), { replace: true });
  }
});
