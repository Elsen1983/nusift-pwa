<template>
  <Transition name="fade">
    <div v-if="isOpen" class="fixed inset-0 z-[200] flex items-center justify-center px-4">
      <div class="absolute inset-0 bg-black/85 backdrop-blur-md"></div>
      
      <div class="relative bg-[#1A1A1A] border border-white/10 w-full max-w-sm rounded-3xl p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)] animate-in fade-in zoom-in duration-300">
        <div class="flex flex-col items-center text-center">
          <div class="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mb-6 border border-error/20">
            <span class="material-symbols-outlined text-error text-3xl">logout</span>
          </div>
          
          <h3 class="font-headline text-xl font-bold text-white mb-2 uppercase tracking-tight">Terminate Session?</h3>
          <p class="text-on-surface-variant text-sm mb-8 leading-relaxed font-body">
            Are you sure you want to end your secure session? Any unsaved agent configurations or calibration data might be lost.
          </p>
          
          <div class="grid grid-cols-2 gap-4 w-full">
            <button 
              @click="$emit('close')"
              class="py-3 rounded-xl border border-white/10 bg-white/5 text-[10px] font-bold uppercase tracking-widest text-on-surface hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button 
              @click="$emit('confirm')"
              class="py-3 rounded-xl bg-error text-on-error text-[10px] font-bold uppercase tracking-widest hover:bg-error/90 transition-all shadow-[0_0_20px_rgba(255,82,82,0.25)]"
            >
              Terminate
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * ANCHOR LOGOUT-MODAL-PROPS
 * Strict enforcement: Close event only emitted via explicit button interaction.
 */
defineProps<{ 
  isOpen: boolean 
}>();

defineEmits(['close', 'confirm']);
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.font-headline { font-family: 'Orbitron', sans-serif; }
.font-body { font-family: 'Rajdhani', sans-serif; }
</style>