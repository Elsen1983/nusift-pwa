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
    return JSON.parse(atob(base64));
  } catch (error) {
    return null;
  }
};

export default defineNuxtRouteMiddleware((to, from) => {
  // Path Constants
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";
  const REGION_CALIBRATION = "/region-calibration";
  const SOURCE_CALIBRATION = "/source-calibration";
  const INTEREST_CALIBRATION = "/interest-calibration";
  const DASHBOARD_PATH = "/dashboard";

  const PUBLIC_ROUTES = [AUTH_PATH, "/verify-email", "/verify", "/reset-password"];
  const isPublicRoute = PUBLIC_ROUTES.includes(to.path);

  const authStore = useAuthStore();
  const tokenCookie = useCookie("auth_token");     // SSR Only
  const sessionStatus = useCookie("session_status"); // Client & Server

  // 1. ANCHOR SESSION-DETECTION
  const hasActiveSession = import.meta.server ? !!tokenCookie.value : !!sessionStatus.value;

  // 2. ANCHOR JWT-HYDRATION (SSR Only)
  if (import.meta.server && tokenCookie.value && !authStore.user) {
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
  // If no cookie exists but Pinia still thinks we are logged in, force a reset.
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