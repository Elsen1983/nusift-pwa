// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./components/**/*.{js,vue,ts}",
    "./layouts/**/*.vue",
    "./pages/**/*.vue",
    "./plugins/**/*.{js,ts}",
    "./app.vue",
    "./error.vue",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: "#131313",
        surface: "#131313",
        "surface-container-high": "#2a2a2a",
        "surface-container-low": "#1c1b1b",
        "surface-container": "#201f1f",
        "surface-container-highest": "#353534",
        "surface-bright": "#393939",
        
        "on-background": "#e5e2e1",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#c0c8ca",
        "outline-variant": "#40484a",
        
        primary: "#ffffff",
        "primary-container": "#00e5ff", // Neon Cyan 
        "on-primary-container": "#00363d",
        
        "tertiary-container": "#f5e2a3",
        "on-tertiary-container": "#716431",
        
        "ai-reasoning-blue": "#40c4ff"
      },
      fontFamily: {
        headline: ["Space Grotesk", "sans-serif"],
        body: ["Manrope", "sans-serif"],
        label: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
}