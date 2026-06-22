/** ANCHOR NUXT-CONFIG-OVERVIEW
 * Central configuration manifest for NuSift.
 * Handles framework versioning, module integration, SEO metadata,
 * PWA configuration, and the Sovereign-Grade design system tokens.
 */
import { resolve } from "node:path"

export default defineNuxtConfig({
  // ANCHOR VERSION-COMPATIBILITY
  future: {
    compatibilityVersion: 4,
  },

  compatibilityDate: "2024-04-03",
  devtools: { enabled: true },

  css: ["~/assets/css/main.css"],

  // ANCHOR VITE-OPTIMIZATION
  // Pre-bundles dynamically injected dependencies to prevent Vite from
  // hard-reloading the browser during development.
  vite: {
    optimizeDeps: {
      include: ["@vue/devtools-core", "@vue/devtools-kit", "workbox-window"],
    },
  },

  // ANCHOR MODULE-REGISTRATION
  modules: [
    "@nuxtjs/tailwindcss", 
    "@pinia/nuxt", 
    "@vite-pwa/nuxt", 
    '@nuxt/icon', 
    "@nuxtjs/i18n",
    "@nuxtjs/color-mode" // ÚJ: Color mode modul hozzáadva
  ],

  // ANCHOR COLOR-MODE CONFIGURATION
  colorMode: {
    classSuffix: '', // Fontos: a Tailwind alapértelmezetten a '.dark' osztályt keresi, nem a '.dark-mode'-ot
    preference: 'dark', // Alapértelmezett beállítás a rendszer szerint
    fallback: 'dark' // Ha nem tudja megállapítani, sötét legyen
  },

  // ANCHOR I18N-CONFIGURATION
  // ts-ignore is used to bypass a type error in the i18n module configuration, which is a known issue with the current version of @nuxtjs/i18n. This allows us to maintain type safety for the rest of the configuration while still using the i18n module effectively.
  i18n: {
    strategy: 'prefix_except_default',
    defaultLocale: 'en',
    restructureDir: '.',
    langDir: 'app/locales',
    detectBrowserLanguage: false, // Letiltva, hogy a saját UI Modalunk irányítson
    locales: [
      { code: 'en', iso: 'en-GB', name: 'English', file: 'en.json' },
      { code: 'hu', iso: 'hu-HU', name: 'Magyar', file: 'hu.json' },
      { code: 'fr', iso: 'fr-FR', name: 'Français', file: 'fr.json' },
      { code: 'de', iso: 'de-DE', name: 'Deutsch', file: 'de.json' },
      { code: 'pl', iso: 'pl-PL', name: 'Polski', file: 'pl.json' },
      { code: 'es', iso: 'es-ES', name: 'Español', file: 'es.json' }
    ]
  },

  // ANCHOR ALIAS-CONFIGURATION
  alias: {
    "@": "./app",
    "@assets": "./app/assets",
    "@components": "./app/components",
    "@layouts": "./app/layouts",
    "@pages": "./app/pages",
    "@img": "./app/assets/images",
  },

  runtimeConfig: {
    vapidPrivateKey: process.env.NUXT_VAPID_PRIVATE_KEY,
    vapidSubject: process.env.NUXT_VAPID_SUBJECT || "mailto:support@nusift.com",
    // Private keys (server-side only)
    // public keys (available to browser)
    public: {
      googleClientId: process.env.NUXT_PUBLIC_GOOGLE_CLIENT_ID,
      appleClientId: process.env.NUXT_PUBLIC_APPLE_CLIENT_ID,
      appUrl: process.env.NUXT_PUBLIC_APP_URL || "http://localhost:3000",
      vapidPublicKey: process.env.NUXT_PUBLIC_VAPID_PUBLIC_KEY,
    },
  },

  app: {
    head: {
      // ANCHOR SEO-METADATA
      title: "NuSift - Sovereign-Grade AI Reader",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#131313" },
      ],
      link: [
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossorigin: "",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Rajdhani:wght@500;600;700&family=Roboto+Mono:wght@400;500;700&family=Inter:wght@400;500&display=swap",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap",
        },
      ],
    },
  },

  // ANCHOR PWA-CONFIGURATION
  pwa: {
    strategies: "injectManifest",
    srcDir: "public",
    filename: "sw.ts",
    registerType: "autoUpdate",
    injectRegister: "auto",
    client: {
      installPrompt: true,
    },
    workbox: {
      globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      navigateFallback: null as any, // Moved inside workbox and cast to bypass TS
      cleanupOutdatedCaches: true,
    },
    manifest: {
      name: "NuSift Sovereign Reader",
      short_name: "NuSift",
      start_url: "/",
      description: "Sovereign-Grade AI Reader and Neural Node",
      theme_color: "#131313",
      background_color: "#131313",
      display: "standalone",
      orientation: "portrait",
      icons: [
        {
          src: "/pwa-192x192.png", // Added leading slash
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "/pwa-512x512.png", // Added leading slash
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: "/pwa-512x512.png", // Added leading slash
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
    devOptions: {
      enabled: true,
      suppressWarnings: true,
      type: "module",
    },
  },

  // ANCHOR TAILWIND-SYSTEM-TOKENS
  // A konfiguráció áthelyezve a tailwind.config.js-be a duplikáció elkerülése végett
  tailwindcss: {
    // Üresen hagyva, mivel a tailwind.config.js kezeli a színeket és a témát
  },

  // ANCHOR CUSTOM-ROUTING
  // Uses Nuxt 3/4 hooks to extend the file-based router
  hooks: {
    "pages:extend"(pages) {
      pages.push(
        {
          name: "verify-email-custom",
          path: "/verify-email",
          file: resolve("app/pages/verifyEmail/verify-email.vue"),
        },
        {
          name: "verify-custom",
          path: "/verify",
          file: resolve("app/pages/verifyEmail/verify.vue"),
        },
        {
          name: "preloader-custom",
          path: "/preloader-page",
          file: resolve("app/pages/preloader/preloader-first.vue"),
        },
        {
          name: "region-calibration-custom",
          path: "/region-calibration",
          file: resolve("app/pages/calibration/region-calibration.vue"),
        },
        {
          name: "source-calibration-custom",
          path: "/source-calibration",
          file: resolve("app/pages/calibration/source-calibration.vue"),
        },
        {
          name: "interest-calibration-custom",
          path: "/interest-calibration",
          file: resolve("app/pages/calibration/interest-calibration.vue"),
        },
        {
          name: "preloader-custom-two",
          path: "/initialization-preloader-page",
          file: resolve("app/pages/preloader/preloader-second.vue"),
        },
        {
          name: "dashboard-initiate-custom",
          path: "/dashboard-initiate",
          file: resolve("app/pages/dashboard/initiate-dashboard.vue"),
        },
        {
          name: "dashboard-custom",
          path: "/dashboard",
          file: resolve("app/pages/dashboard/dashboard-main.vue"),
        },
        {
          name: "reset-password",
          path: "/reset-password",
          file: resolve("app/pages/reset-password.vue"),
        },
        {
          name: "source-manager-custom",
          path: "/audit/source-manager",
          file: resolve("app/pages/audit/source-manager.vue"),
        }
      );
    },
  },

  // ANCHOR TYPE-SAFETY
  typescript: {
    strict: true,
  },
});
