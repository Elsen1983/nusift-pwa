<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container">
    <NuxtPage /> 
  </div>
</template>

<style>
/* Material Symbols Alapbeállítás */
.material-symbols-outlined {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* Glassmorphism Utility Class */
.glass-panel {
  background: rgba(28, 27, 27, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* Gördítősáv elrejtése, ha kell */
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>