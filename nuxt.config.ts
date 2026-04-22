/** * ANCHOR NUXT-CONFIG-OVERVIEW
 * Central configuration manifest for NuSift.
 * Handles framework versioning, module integration, SEO metadata,
 * and the Sovereign-Grade design system tokens.
 */

export default defineNuxtConfig({
  // ANCHOR VERSION-COMPATIBILITY
  // Enables Nuxt 4 features and the new /app directory structure.
  // This is critical for the project's modern architectural alignment.
  future: {
    compatibilityVersion: 4,
  },

  compatibilityDate: "2024-04-03",
  devtools: { enabled: true },

  // ANCHOR MODULE-REGISTRATION
  // TailwindCSS for styling and Pinia for state management (Sovereign Node State).
  modules: ["@nuxtjs/tailwindcss", "@pinia/nuxt"],

  app: {
    head: {
      // ANCHOR SEO-METADATA
      title: "NuSift - Sovereign-Grade AI Reader",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#131313" },
      ],
      link: [
        // ANCHOR EXTERNAL-RESOURCES
        // Preconnecting to Google Fonts for optimized latency during neural handshake.
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossorigin: "",
        },
        // ANCHOR TYPOGRAPHY-DEFINITION
        // Loading the core font families: Orbitron (Headlines), Rajdhani (Body), Roboto Mono (Labels).
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

  // ANCHOR TAILWIND-SYSTEM-TOKENS
  // Mapping the design system to Tailwind classes for rapid, consistent UI development.
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
            // ANCHOR COLOR-PALETTE
            // Material Design 3 inspired dark palette for maximum legibility in low light.
            background: "#131313",
            surface: "#1e1e1e",
            "primary-container": "#00ffff", // Neon cyan accent
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
