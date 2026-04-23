/**
 * ANCHOR GUARD-OVERVIEW
 * NuSift Global Route Guard
 * This middleware acts as the primary traffic controller for the application.
 * It ensures that unauthenticated or first-time users are funneled toward 
 * the 'Sovereign Handshake' (Auth) process, while allowing access to whitelisted public routes.
 */

export default defineNuxtRouteMiddleware((to, from) => {
  
  // ANCHOR CONSTANTS
  // Centralized path definitions to avoid hardcoded string errors across the app.
  const AUTH_PATH = "/auth";
  const DASHBOARD_PATH = '/app/dashboard';
  const ROOT_PATH = "/";
  
  // ANCHOR WHITELIST-ROUTING
  // These routes are exempt from authentication checks.
  // Add '/verify-email', preloaders, or public landing pages here.
  const PUBLIC_ROUTES = [
    AUTH_PATH,
    '/verify-email',
    '/preloader-page' // Ezt is add hozzá, ha tesztelni akarod
  ];

  // If the target path is in the public whitelist, let them pass immediately.
  // This executes on BOTH server and client sides.
  if (PUBLIC_ROUTES.includes(to.path)) {
    return;
  }

  // ANCHOR SSR-HANDLING
  // Server-Side Rendering Check for PROTECTED routes:
  // Since localStorage is unavailable on the server, we perform a proactive
  // redirect for protected routes to prevent flashing of unauthorized content.
  if (import.meta.server) {
    if (to.path === ROOT_PATH) {
      return navigateTo(AUTH_PATH); 
    }
    // We cannot verify 'nusift_visited' on the server, so we safely return 
    // and let the client-side logic handle the actual check.
    return;
  }

  // ANCHOR STATE-RETRIEVAL
  // Client-side execution starts here for PROTECTED routes.
  // We check for the 'nusift_visited' flag to identify returning sovereign users.
  const hasVisited = localStorage.getItem("nusift_visited");
  
  // FUTURE_ANCHOR PINIA-INTEGRATION
  // This is the landing spot for the future UserStore.isLoggedIn check.
  const isLoggedIn = false;

  // ANCHOR REDIRECT-LOGIC
  // Logic Gate 1: First time visitor trying to access a PROTECTED route.
  if (!hasVisited) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  // ANCHOR ROOT-DISPATCHER
  // Logic Gate 2: Root Path handling.
  // The "/" path is never a final destination; it always dispatches 
  // users to their relevant environment based on auth status.
  if (to.path === ROOT_PATH) {
    const target = isLoggedIn ? DASHBOARD_PATH : AUTH_PATH;
    return navigateTo(target, { replace: true });
  }

  // ANCHOR SECURITY-AUDIT
  // Additional safety checks or role-based access control (RBAC) 
  // can be inserted here as the NuSift ecosystem expands.
});