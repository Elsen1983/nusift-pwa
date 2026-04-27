<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0" 
    enter-to-class="opacity-100" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100" 
    leave-to-class="opacity-0"
  >
    <div v-if="modelValue" class="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center" @click.self="$emit('update:modelValue', false)">
      <div class="bg-[#353534] border border-[#40484a]/30 rounded-3xl p-6 max-w-[320px] w-[90%] shadow-[0_0_40px_rgba(0,229,255,0.08)] relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-b from-[#201f1f]/10 to-transparent pointer-events-none"></div>
        <div class="relative z-10 flex flex-col items-center text-center">
          <div class="w-14 h-14 bg-[#201f1f] rounded-full flex items-center justify-center mb-5 border border-[#40484a]/20 shadow-inner">
            <span class="material-symbols-outlined text-[28px] text-[#9ecfd8]" :style="{ fontVariationSettings: '\'FILL\' 1' }">lock</span>
          </div>
          <h3 class="font-headline text-[#e5e2e1] font-bold text-lg mb-3 leading-tight tracking-tight">Paywall Detected</h3>
          <p class="text-xs font-body text-[#c0c8ca] leading-relaxed mb-8 px-2">
            This article is published behind a paywall. Use our secure protocol or open in browser.
          </p>
          <div class="flex flex-col gap-3 w-full">
            <button @click="$emit('browser')" class="w-full h-11 bg-[#201f1f] border border-[#40484a]/30 text-[#e5e2e1] font-label text-xs font-bold rounded-full flex items-center justify-center gap-2 hover:bg-[#393939]">
              <span class="material-symbols-outlined text-[18px]">open_in_browser</span> Open in Browser
            </button>
            <button @click="$emit('read')" class="w-full h-11 relative overflow-hidden rounded-full font-label text-xs font-bold tracking-wider uppercase group">
              <div class="absolute inset-0 bg-gradient-to-r from-[#ffffff] to-[#b9ebf5] opacity-90 group-hover:opacity-100 transition-opacity"></div>
              <span class="relative z-10 text-[#001f24] flex items-center justify-center gap-2">
                <span class="material-symbols-outlined text-[18px]" :style="{ fontVariationSettings: '\'FILL\' 1' }">menu_book</span> Read in NuSift
              </span>
            </button>
            <button @click="$emit('update:modelValue', false)" class="mt-2 text-[10px] font-label text-[#c0c8ca]/70 hover:text-[#e5e2e1] py-2 uppercase tracking-wider font-bold">Cancel</button>
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