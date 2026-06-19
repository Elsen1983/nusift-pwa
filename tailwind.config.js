/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./app/components/**/*.{js,vue,ts}",
    "./app/layouts/**/*.vue",
    "./app/pages/**/*.vue",
    "./app/plugins/**/*.{js,ts}",
    "./app/app.vue",
    "./app/error.vue",
  ],
  darkMode: "class", // Ez nagyon fontos, hogy itt legyen!
  theme: {
    extend: {
      colors: {
        background:
          "rgb(var(--color-background) / var(--theme-bg-opacity, <alpha-value>))",
        surface: "rgb(var(--color-surface) / <alpha-value>)",

        "surface-container-high":
          "rgb(var(--color-surface-container-high) / <alpha-value>)",
        "surface-container-low":
          "rgb(var(--color-surface-container-low) / <alpha-value>)",
        "surface-container":
          "rgb(var(--color-surface-container) / <alpha-value>)",
        "surface-container-highest":
          "rgb(var(--color-surface-container-highest) / <alpha-value>)",
        "surface-bright": "rgb(var(--color-surface-bright) / <alpha-value>)",
        "surface-container-lowest":
          "rgb(var(--color-surface-container-lowest) / <alpha-value>)",

        "on-background": "rgb(var(--color-on-background) / <alpha-value>)",
        "on-surface": "rgb(var(--color-on-surface) / <alpha-value>)",
        "on-surface-variant":
          "rgb(var(--color-on-surface-variant) / <alpha-value>)",
        "outline-variant": "rgb(var(--color-outline-variant) / <alpha-value>)",

        "semantic-rating": "rgb(var(--color-semantic-rating) / <alpha-value>)",
        "semantic-paywall":
          "rgb(var(--color-semantic-paywall) / <alpha-value>)",
        "semantic-ai": "rgb(var(--color-semantic-ai) / <alpha-value>)",
        "semantic-ai-variant":
          "rgb(var(--color-semantic-ai-variant) / <alpha-value>)",

        primary: "rgb(var(--color-primary) / <alpha-value>)",
        "primary-container":
          "rgb(var(--color-primary-container) / <alpha-value>)",
        "on-primary-container":
          "rgb(var(--color-on-primary-container) / <alpha-value>)",

        error: "rgb(var(--color-error) / <alpha-value>)",
        "on-error": "rgb(var(--color-on-error) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        "on-warning": "rgb(var(--color-on-warning) / <alpha-value>)",

        success: "rgb(var(--color-success) / <alpha-value>)",
        "on-success": "rgb(var(--color-on-success) / <alpha-value>)",
        
        "chart-1": "rgb(var(--color-chart-1) / <alpha-value>)",
        "chart-2": "rgb(var(--color-chart-2) / <alpha-value>)",
        "chart-3": "rgb(var(--color-chart-3) / <alpha-value>)",
        "chart-4": "rgb(var(--color-chart-4) / <alpha-value>)",
        "chart-5": "rgb(var(--color-chart-5) / <alpha-value>)",
        "chart-6": "rgb(var(--color-chart-6) / <alpha-value>)",
      },
      fontFamily: {
        headline: ["Space Grotesk", "sans-serif"],
        body: ["Manrope", "sans-serif"],
        label: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
