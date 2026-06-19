<template>
  <Transition name="fade">
    <div v-if="isOpen" class="fixed inset-0 z-[200] flex items-center justify-center px-4">
      <div class="absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-md"></div>
      
      <div class="relative bg-surface-container-high border border-outline-variant/30 w-full max-w-sm rounded-3xl p-8 shadow-2xl animate-in fade-in zoom-in duration-300">
        <div class="flex flex-col items-center text-center">
          <div class="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mb-6 border border-error/20">
            <span class="material-symbols-outlined text-error text-3xl">logout</span>
          </div>
          
          <h3 class="font-headline text-xl font-bold text-on-surface mb-2 uppercase tracking-tight">{{ $t('logoutModal.title') }}</h3>
          <p class="text-on-surface-variant text-sm mb-8 leading-relaxed font-body">
            {{ $t('logoutModal.description') }}
          </p>
          
          <div class="grid grid-cols-2 gap-4 w-full">
            <button 
              @click="$emit('close')"
              class="py-3 rounded-xl border border-outline-variant/30 bg-surface-bright text-[10px] font-bold uppercase tracking-widest text-on-surface hover:brightness-110 transition-colors"
            >
              {{ $t('logoutModal.btn_cancel') }}
            </button>
            <button 
              @click="$emit('confirm')"
              class="py-3 rounded-xl bg-error text-on-error text-[10px] font-bold uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-error/20"
            >
              {{ $t('logoutModal.btn_terminate') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{ isOpen: boolean }>();
defineEmits(['close', 'confirm']);
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>