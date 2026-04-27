/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard (Sovereign Shield 4.1 - Error Recovery Optimized)
 * This guard handles authentication, onboarding flow, and prevents navigation loops.
 */
import { useAuthStore } from "~/stores/auth";

export default defineNuxtRouteMiddleware((to, from) => {
  // ANCHOR CONSTANTS
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";

  // Onboarding routes synchronized with nuxt.config.ts hooks
  const SOURCE_CALIBRATION = "/source-calibration";
  const INTEREST_CALIBRATION = "/interest-calibration";
  const DASHBOARD_PATH = "/dashboard";

  const PUBLIC_ROUTES = [AUTH_PATH, "/verify-email"];
  const isPublicRoute = PUBLIC_ROUTES.includes(to.path);

  const tokenCookie = useCookie("auth_token");
  const authStore = useAuthStore();
  const hasToken = !!tokenCookie.value;

  // ANCHOR INLINE-HYDRATION
  // Restores session state on hard refresh (F5) if token exists
  if (hasToken && !authStore.user) {
    authStore.user = {
      id: "session-restored",
      email: "restoring...",
      createdAt: new Date().toISOString(),
      onboardingStep: 0,
    };
  }

  const isAuthenticated = authStore.user !== null;
  const currentStep = authStore.user?.onboardingStep || 0;

  /**
   * ANCHOR TARGET-RESOLVER
   * Calculates where the user should be based on their onboarding progress.
   */
  const getOnboardingTarget = (step: number) => {
    if (step === 0) return SOURCE_CALIBRATION;
    if (step === 1) return INTEREST_CALIBRATION;
    return DASHBOARD_PATH;
  };

  // ANCHOR SSR-HANDLING
  if (import.meta.server) {
    if (to.path === ROOT_PATH) {
      return navigateTo(
        isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH,
      );
    }

    if (!isAuthenticated && !isPublicRoute) {
      return navigateTo(AUTH_PATH);
    }

    // BREAKING THE LOOP: If authenticated but hitting AUTH_PATH, we allow it
    // to prevent circular redirects during error recovery.
    if (isAuthenticated && to.path === AUTH_PATH) {
      return;
    }
    return;
  }

  // ANCHOR CLIENT-LOGIC
  const hasVisited = localStorage.getItem("nusift_visited");

  // Root handling
  if (to.path === ROOT_PATH) {
    return navigateTo(
      isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH,
      { replace: true },
    );
  }

  // Public access control
  if (!isAuthenticated && !isPublicRoute) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  /**
   * ANCHOR ERROR-RECOVERY-EXCEPTION
   * Crucial Fix: If an authenticated user lands on /auth (triggered by error.vue),
   * we stop the guard from forcing them back to the broken onboarding route.
   */
  if (isAuthenticated && to.path === AUTH_PATH) {
    console.warn(
      "[Sovereign Shield] Authenticated user on Auth Path - Holding for recovery.",
    );
    return;
  }

  // Final fallback to onboarding flow for authenticated users on non-public routes
  if (
    isAuthenticated &&
    !isPublicRoute &&
    to.path !== getOnboardingTarget(currentStep) &&
    to.path === ROOT_PATH
  ) {
    return navigateTo(getOnboardingTarget(currentStep));
  }
});
