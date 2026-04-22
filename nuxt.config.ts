/** ANCHOR NUXT-CONFIG-OVERVIEW
 * Central configuration manifest for NuSift.
 * Handles framework versioning, module integration, SEO metadata,
 * PWA configuration, and the Sovereign-Grade design system tokens.
 */

export default defineNuxtConfig({
  // ANCHOR VERSION-COMPATIBILITY
  future: {
    compatibilityVersion: 4,
  },

  compatibilityDate: "2024-04-03",
  devtools: { enabled: true },

  // ANCHOR VITE-OPTIMIZATION
  // Pre-bundles dynamically injected dependencies to prevent Vite from 
  // hard-reloading the browser during development.
  vite: {
    optimizeDeps: {
      include: [
        '@vue/devtools-core',
        '@vue/devtools-kit',
        'workbox-window',
      ]
    }
  },

  // ANCHOR MODULE-REGISTRATION
  modules: ["@nuxtjs/tailwindcss", "@pinia/nuxt", "@vite-pwa/nuxt"],

  // ANCHOR ALIAS-CONFIGURATION
  alias: {
    "@": "./app",
    "@assets": "./app/assets",
    "@components": "./app/components",
    "@layouts": "./app/layouts",
    "@pages": "./app/pages",
    "@stores": "./app/stores",
    "@img": "./app/assets/images",
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
    registerType: "autoUpdate",
    injectRegister: "auto",
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
    },
    client: {
      installPrompt: true,
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
  tailwindcss: {
    config: {
      theme: {
        extend: {
          fontFamily: {
            headline: ["Orbitron", "sans-serif"],
            body: ["Rajdhani", "sans-serif"],
            label: ["Roboto Mono", "monospace"],
          },
          colors: {
            background: "#131313",
            surface: "#1e1e1e",
            "primary-container": "#00ffff",
            "on-primary-container": "#000000",
          },
        },
      },
    },
  },

  // ANCHOR TYPE-SAFETY
  typescript: {
    strict: true,
  },
});