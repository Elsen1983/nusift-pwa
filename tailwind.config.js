/** ANCHOR TAILWIND-CONFIG-OVERVIEW
 * NuSift Design System Configuration.
 * Implements a dark-mode first, Material Design 3 (MD3) inspired color palette
 * with 'Sovereign' neon accents for high-fidelity AI interfaces. */

/** @type {import('tailwindcss').Config} */
export default {
  // ANCHOR CONTENT-DETECTION
  // Updated for Nuxt 4: Files are now located within the /app directory.
  content: [
    "./app/components/**/*.{js,vue,ts}",
    "./app/layouts/**/*.vue",
    "./app/pages/**/*.vue",
    "./app/plugins/**/*.{js,ts}",
    "./app/app.vue",
    "./app/error.vue",
  ],

  darkMode: "class",

  theme: {
    extend: {
      // ANCHOR COLOR-SYSTEM
      // MD3 Elevation system implementation using semantic naming.
      colors: {
        // Base backgrounds
        background: "#131313",
        surface: "#131313",

        // ANCHOR SURFACE-CONTAINERS
        // These represent different elevation levels in the neural UI.
        "surface-container-high": "#2a2a2a",
        "surface-container-low": "#1c1b1b",
        "surface-container": "#201f1f",
        "surface-container-highest": "#353534",
        "surface-bright": "#393939",

        // ANCHOR CONTENT-COLORS
        // High-contrast tokens for text and iconography.
        "on-background": "#e5e2e1",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#c0c8ca",
        "outline-variant": "#40484a",

        // ANCHOR ACCENT-COLORS
        // Sovereign neon tones for CTAs and AI-driven insights.
        primary: "#ffffff",
        "primary-container": "#00e5ff", // Neon Cyan
        "on-primary-container": "#00363d",

        "tertiary-container": "#f5e2a3",
        "on-tertiary-container": "#716431",

        // Specialty token for AI engine feedback
        "ai-reasoning-blue": "#40c4ff",
      },

      // ANCHOR TYPOGRAPHY-SYSTEM
      // Mapping the brand's geometric and grotesque fonts.
      fontFamily: {
        headline: ["Space Grotesk", "sans-serif"],
        body: ["Manrope", "sans-serif"],
        label: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
