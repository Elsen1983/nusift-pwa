<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container">
    <VitePwaManifest />
    <NuxtPage /> 
  </div>
</template>

<style>
/* ANCHOR: GLOBAL-STYLES
   Universal CSS rules that govern core UI components and utility behaviors. */

/* ANCHOR: ICONOGRAPHY-CONFIG
   Material Symbols base configuration. Ensures consistent weight and optical size. */
.material-symbols-outlined {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* ANCHOR: GLASSMORPHISM-UTILITY
   Standard glass panel effect for overlays, drawers, and floating cards. 
   Uses backdrop-blur for the high-end neural aesthetic. */
.glass-panel {
  background: rgba(28, 27, 27, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ANCHOR: SCROLLBAR-MANAGEMENT
   Utility class to hide scrollbars while maintaining functionality. 
   Critical for clean, app-like mobile interfaces. */
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>