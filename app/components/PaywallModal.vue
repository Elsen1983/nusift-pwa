<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0" 
    enter-to-class="opacity-100" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100" 
    leave-to-class="opacity-0"
  >
    <div v-if="modelValue" class="fixed inset-0 z-[120] bg-surface-container-lowest/80 backdrop-blur-sm flex items-center justify-center" @click.self="$emit('update:modelValue', false)">
      <div class="bg-surface-container-highest border border-outline-variant/30 rounded-3xl p-6 max-w-[320px] w-[90%] shadow-xl shadow-primary-container/10 relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-b from-surface-container-lowest/20 to-transparent pointer-events-none"></div>
        <div class="relative z-10 flex flex-col items-center text-center">
          <div class="w-14 h-14 bg-surface-container-lowest rounded-full flex items-center justify-center mb-5 border border-outline-variant/20 shadow-inner">
            <span class="material-symbols-outlined text-[28px] text-primary-container" :style="{ fontVariationSettings: '\'FILL\' 1' }">lock</span>
          </div>
          <h3 class="font-headline text-on-surface font-bold text-lg mb-3 leading-tight tracking-tight">
            {{ $t('paywallModal.title') }}
          </h3>
          <p class="text-[14px] font-body text-on-surface-variant leading-relaxed mb-8 px-2">
            {{ $t('paywallModal.description') }}
          </p>
          <div class="flex flex-col gap-3 w-full">
            <button @click="$emit('browser')" class="w-full h-11 bg-surface-container-lowest border border-outline-variant/30 text-on-surface font-label text-xs font-bold rounded-full flex items-center justify-center gap-2 hover:bg-surface-bright transition-colors">
              <span class="material-symbols-outlined text-[18px]">open_in_browser</span> 
              {{ $t('paywallModal.btn_browser') }}
            </button>
            <button @click="$emit('read')" class="w-full h-11 bg-primary-container hover:brightness-110 transition-all rounded-full font-label text-xs font-bold tracking-wider uppercase group">
              <span class="relative z-10 text-on-primary-container flex items-center justify-center gap-2">
                <span class="material-symbols-outlined text-[18px]" :style="{ fontVariationSettings: '\'FILL\' 1' }">menu_book</span> 
                {{ $t('paywallModal.btn_read') }}
              </span>
            </button>
            <button @click="$emit('update:modelValue', false)" class="mt-2 text-[14px] font-label text-on-surface-variant hover:text-on-surface py-2 uppercase tracking-wider font-bold transition-colors">
              {{ $t('paywallModal.btn_cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean }>();
defineEmits(['update:modelValue', 'browser', 'read']);
</script>