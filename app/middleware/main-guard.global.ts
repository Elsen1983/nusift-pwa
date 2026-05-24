/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard (Sovereign Shield 6.1 - Ghost State Prevention)
 */
import { useAuthStore } from "~/stores/auth";

const decodeJwtPayload = (token: string) => {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    
    if (import.meta.server) {
      return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    } else {
      return JSON.parse(atob(base64));
    }
  } catch (error) {
    console.error("Sovereign Shield: JWT Decode Error", error);
    return null;
  }
};

export default defineNuxtRouteMiddleware(async (to, from) => {
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";
  const REGION_CALIBRATION = "/region-calibration";
  const SOURCE_CALIBRATION = "/source-calibration";
  const INTEREST_CALIBRATION = "/interest-calibration";
  const DASHBOARD_PATH = "/dashboard";

  const PUBLIC_ROUTES = [AUTH_PATH, "/verify-email", "/verify", "/reset-password"];
  const isPublicRoute = PUBLIC_ROUTES.includes(to.path);

  const authStore = useAuthStore();
  const tokenCookie = useCookie("auth_token");     
  const sessionStatus = useCookie("session_status"); 

  let hasActiveSession = import.meta.server ? !!tokenCookie.value : !!sessionStatus.value;

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
      sessionStatus.value = null;
      hasActiveSession = false;
      authStore.$reset();
      
      return navigateTo(AUTH_PATH, { replace: true });
    }
  }
  // 2. ANCHOR JWT-HYDRATION (SSR Only)
  if (import.meta.server && hasActiveSession && !authStore.user) {
    const payload = decodeJwtPayload(tokenCookie.value as string);
    if (payload && payload.userId) {
      authStore.user = {
        id: payload.userId,
        email: payload.email,
        onboardingStep: payload.onboardingStep ?? 0,
        createdAt: new Date().toISOString(),
        primaryRegion: null,
        topSources: [],
        topInterests: [],
      };
    }
  }

  // 3. ANCHOR SYNC-CHECK (Ghost State Prevention)
  if (!hasActiveSession && authStore.user !== null) {
    authStore.$reset();
  }

  const isAuthenticated = authStore.user !== null && hasActiveSession;
  const currentStep = authStore.user?.onboardingStep || 0;

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
  if (isAuthenticated && to.path === AUTH_PATH) {
    return navigateTo(targetPath);
  }

  // Handle Root Path
  if (to.path === ROOT_PATH) {
    return navigateTo(isAuthenticated ? targetPath : AUTH_PATH);
  }

  // Protect private routes
  if (!isAuthenticated && !isPublicRoute) {
    return navigateTo(AUTH_PATH, { replace: true });
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

  if (isFullyOnboarded && LOCKED_ONBOARDING_ROUTES.includes(to.path)) {
    return navigateTo(DASHBOARD_PATH, { replace: true });
  }

  if (
    isAuthenticated &&
    !isFullyOnboarded &&
    to.path !== targetPath &&
    !isPublicRoute &&
    to.path !== DASHBOARD_PATH &&
    !ALL_TRANSITIONAL_ROUTES.includes(to.path)
  ) {
    return navigateTo(targetPath, { replace: true });
  }
});