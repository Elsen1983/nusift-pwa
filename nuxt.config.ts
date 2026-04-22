// nuxt.config.ts
export default defineNuxtConfig({
  // 1. Nuxt 4 Compatibility Flag
  // This tells Nuxt to look for files in the /app folder
  future: {
    compatibilityVersion: 4,
  },

  compatibilityDate: "2024-04-03",
  devtools: { enabled: true },

  modules: ["@nuxtjs/tailwindcss", "@pinia/nuxt"],

  app: {
    head: {
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
        // Optimized Google Fonts for NuSift Identity
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

  // 2. Tailwind configuration for Sovereign-Grade UI tokens
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
            // Material Design 3 inspired dark palette
            background: "#131313",
            surface: "#1e1e1e",
            "primary-container": "#00ffff", // Placeholder neon cyan
            "on-primary-container": "#000000",
          },
        },
      },
    },
  },

  typescript: {
    strict: true,
  },
});
