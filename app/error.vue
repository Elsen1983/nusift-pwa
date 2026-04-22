<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container relative overflow-hidden flex flex-col items-center justify-center px-8 py-6 z-10">
    
    <div class="fixed top-[-10%] left-[-10%] w-[50%] h-[50%] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"></div>
    <div class="fixed bottom-[5%] right-[-5%] w-[40%] h-[40%] bg-secondary-container/5 blur-[100px] rounded-full -z-10 pointer-events-none"></div>

    <main class="text-center space-y-8 max-w-md w-full relative z-20">
      
      <h1 class="font-headline text-9xl font-extrabold tracking-tighter text-primary-container animate-pulse drop-shadow-[0_0_15px_rgba(0,255,255,0.5)]">
        {{ error?.statusCode || '???' }}
      </h1>

      <div class="space-y-3">
        <h2 class="font-headline text-2xl md:text-3xl font-bold tracking-tight text-on-surface uppercase">
          {{ is404 ? 'Neural Path Disrupted' : 'System Anomaly Detected' }}
        </h2>
        <p class="text-[10px] md:text-xs text-on-surface-variant font-label uppercase tracking-[0.25em] leading-relaxed opacity-80 px-4">
          {{ is404 ? 'The requested coordinates do not match any known NuSift node.' : 'The sovereign handshake failed. Integrity check required.' }}
        </p>
      </div>

      <div class="pt-6 px-4">
        <button
          @click="handleError"
          class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-4 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all uppercase tracking-widest text-sm"
        >
          {{ is404 ? 'Return to Known Network' : 'Attempt System Reboot' }}
        </button>
      </div>

      <footer class="mt-12 opacity-60">
        <p class="text-[9px] text-zinc-600 font-label uppercase tracking-[0.4em]">
          Sovereign-Grade Recovery Protocol
        </p>
      </footer>
    </main>

  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NuxtError } from '#app'

/** ANCHOR ERROR-PROPS
 * Nuxt 3/4 automatically injects the error object as a prop. */
const props = defineProps({
  error: Object as () => NuxtError
})

/** ANCHOR COMPUTED-LOGIC
 * Checks if the current error is a 404 for tailored UI feedback. */
const is404 = computed(() => props.error?.statusCode === 404)

/** ANCHOR NAVIGATION-RECOVERY
 * Resets the Nuxt error state and forces a clean redirect to /auth. 
 * This ensures the user doesn't get stuck in a broken routing state. */
const handleError = () => clearError({ redirect: '/auth' })
</script>

<style scoped>
/* ANCHOR TYPOGRAPHY-SCOPE
   Ensuring consistent sci-fi font application within the error boundary. */
.font-headline { font-family: 'Orbitron', sans-serif; }
.font-label { font-family: 'Roboto Mono', monospace; }
.font-body { font-family: 'Rajdhani', sans-serif; }

/* ANCHOR ANIMATION-DEFINITIONS
   Pulse-neon effect for the status code to add a 'living' system feel. */
@keyframes pulse-neon {
  0%, 100% { opacity: 1; filter: drop-shadow(0 0 15px rgba(0,255,255,0.5)); }
  50% { opacity: 0.8; filter: drop-shadow(0 0 30px rgba(0,255,255,0.8)); }
}

.animate-pulse {
  animation: pulse-neon 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
</style>