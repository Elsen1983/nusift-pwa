/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard (Sovereign Shield 5.0 - JWT Synchronized)
 */
import { useAuthStore } from "~/stores/auth";

// Egy apró segédfüggvény, ami titkosítás-ellenőrzés nélkül kiolvassa a JWT tartalmát a routinghoz
const decodeJwtPayload = (token: string) => {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)); // atob() univerzálisan működik Node.js-ben és böngészőben is
  } catch (error) {
    return null;
  }
};

export default defineNuxtRouteMiddleware((to, from) => {
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";
  const REGION_CALIBRATION = "/region-calibration";
  const SOURCE_CALIBRATION = "/source-calibration";
  const INTEREST_CALIBRATION = "/interest-calibration";
  const DASHBOARD_PATH = "/dashboard";

  const PUBLIC_ROUTES = [AUTH_PATH, "/verify-email", "/verify"];
  const isPublicRoute = PUBLIC_ROUTES.includes(to.path);

  const tokenCookie = useCookie("auth_token");
  const authStore = useAuthStore();
  const hasToken = !!tokenCookie.value;

  // ANCHOR JWT-HYDRATION
  // A szerver és a kliens is pontosan ugyanazt az adatot olvassa ki a sütiből! Nincs több mismatch!
  if (hasToken && !authStore.user) {
    const payload = decodeJwtPayload(tokenCookie.value as string);
    if (payload && payload.userId) {
      authStore.user = {
        id: payload.userId,
        email: payload.email,
        onboardingStep: payload.onboardingStep ?? 0,
        createdAt: new Date().toISOString(),
        // Add default values for the missing required fields
        primaryRegion: null,
        topSources: [],
        topInterests: [],
      };
    } else if (import.meta.client) {
      tokenCookie.value = null; // Hibás token törlése a kliensen
    }
  }

  const isAuthenticated = authStore.user !== null;
  const currentStep = authStore.user?.onboardingStep || 0;

  const getOnboardingTarget = (step: number) => {
    switch (step) {
      case 0:
        return REGION_CALIBRATION;
      case 1:
        return SOURCE_CALIBRATION;
      case 2:
        return INTEREST_CALIBRATION;
      default:
        return DASHBOARD_PATH;
    }
  };

  // SSR Handling
  if (import.meta.server) {
    if (to.path === ROOT_PATH)
      return navigateTo(
        isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH,
      );
    if (!isAuthenticated && !isPublicRoute) return navigateTo(AUTH_PATH);
    if (isAuthenticated && to.path === AUTH_PATH) return;
    return;
  }

  // Client Handling
  if (to.path === ROOT_PATH) {
    return navigateTo(
      isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH,
      { replace: true },
    );
  }

  if (!isAuthenticated && !isPublicRoute) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  if (isAuthenticated && to.path === AUTH_PATH) {
    return;
  }

  // 1. Routes that fully onboarded users are NEVER allowed to visit again
  const LOCKED_ONBOARDING_ROUTES = [
    "/preloader-page",
    "/region-calibration",
    "/source-calibration",
    "/interest-calibration",
  ];

  // 2. Transitional animations that happen after onboarding but before the dashboard
  const POST_ONBOARDING_PAGES = [
    "/initialization-preloader-page",
    "/dashboard-initiate",
  ];

  // Combine them for the un-onboarded user logic
  const ALL_TRANSITIONAL_ROUTES = [
    ...LOCKED_ONBOARDING_ROUTES,
    ...POST_ONBOARDING_PAGES,
  ];

  const targetPath = getOnboardingTarget(currentStep);
  const isFullyOnboarded = currentStep >= 3;

  // FIX: If fully onboarded, only block them from the LOCKED routes.
  // Let them pass through the post-onboarding animations!
  if (isFullyOnboarded && LOCKED_ONBOARDING_ROUTES.includes(to.path)) {
    return navigateTo(DASHBOARD_PATH, { replace: true });
  }

  // If the user is authenticated but not fully onboarded, keep them on track
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
