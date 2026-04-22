// app/middleware/main-guard.global.ts
export default defineNuxtRouteMiddleware((to, from) => {
  // 1. Path Constants
  const AUTH_PATH = "/auth";
  const DASHBOARD_PATH = '/app/dashboard';
  const ROOT_PATH = "/";

  // 2. SSR Check: A szerver nem látja a localStorage-ot.
  // Megoldás: Szerver oldalon CSAK a "/" útvonalat irányítjuk át alapértelmezetten, 
  // vagy hagyjuk, hogy a kliens döntsön.
  if (import.meta.server) {
    if (to.path === ROOT_PATH) {
      return navigateTo(AUTH_PATH); // Szerver oldali gyors-irányítás
    }
    return;
  }

  // 3. Client-side Logic (már van localStorage)
  const hasVisited = localStorage.getItem("nusift_visited");
  const isLoggedIn = false;

  // CASE 1: First time visitor
  if (!hasVisited && to.path !== AUTH_PATH) {
    return navigateTo(AUTH_PATH, { replace: true });
  }

  // CASE 2: Routing from Root
  if (to.path === ROOT_PATH) {
    const target = isLoggedIn ? DASHBOARD_PATH : AUTH_PATH;
    return navigateTo(target, { replace: true });
  }
});