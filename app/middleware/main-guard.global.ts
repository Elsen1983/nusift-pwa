/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard (Sovereign Shield 4.0 - PWA & Onboarding Ready)
 */
import { useAuthStore } from '~/stores/auth';

export default defineNuxtRouteMiddleware((to, from) => {
  
  // ANCHOR CONSTANTS
  const AUTH_PATH = "/auth";
  const ROOT_PATH = "/";
  const PRELOADER_PATH = '/preloader-page'; // Első preloader
  
  // Onboarding útvonalak
  const SOURCE_CALIBRATION = '/app/source-calibration';
  const INTEREST_CALIBRATION = '/app/interest-calibration';
  const DASHBOARD_PATH = '/app/dashboard';
  
  const PUBLIC_ROUTES = [AUTH_PATH, '/verify-email'];
  const isPublicRoute = PUBLIC_ROUTES.includes(to.path);

  const tokenCookie = useCookie('auth_token');
  const authStore = useAuthStore();
  const hasToken = !!tokenCookie.value;

  // ANCHOR INLINE-HYDRATION (F5 esetén)
  if (hasToken && !authStore.user) {
    authStore.user = { 
      id: 'session-restored', 
      email: 'restoring...', 
      createdAt: new Date().toISOString(),
      onboardingStep: 0 // Placeholder
    };
  }

  const isAuthenticated = authStore.user !== null;
  const currentStep = authStore.user?.onboardingStep || 0;

  // Dinamikus célobjektum kiszámítása
  const getOnboardingTarget = (step: number) => {
    if (step === 0) return SOURCE_CALIBRATION;
    if (step === 1) return INTEREST_CALIBRATION;
    return DASHBOARD_PATH; // step >= 2
  };

  // ANCHOR SSR-HANDLING
  if (import.meta.server) {
    if (to.path === ROOT_PATH) {
      return navigateTo(isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH); 
    }

    if (!isAuthenticated && !isPublicRoute) {
      return navigateTo(AUTH_PATH);
    }

    if (isAuthenticated && to.path === AUTH_PATH) {
      return navigateTo(getOnboardingTarget(currentStep));
    }
    return; 
  }

  // ANCHOR CLIENT-LOGIC
  const hasVisited = localStorage.getItem("nusift_visited");

  if (to.path === ROOT_PATH) {
    return navigateTo(isAuthenticated ? getOnboardingTarget(currentStep) : AUTH_PATH, { replace: true });
  }

  if (!hasVisited && !isPublicRoute) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  if (!isAuthenticated && !isPublicRoute) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  if (isAuthenticated && to.path === AUTH_PATH) {
    return navigateTo(getOnboardingTarget(currentStep), { replace: true });
  }
});