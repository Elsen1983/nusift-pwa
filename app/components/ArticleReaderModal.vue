<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0 translate-y-4" 
    enter-to-class="opacity-100 translate-y-0" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100 translate-y-0" 
    leave-to-class="opacity-0 translate-y-4"
  >
    <div v-if="modelValue && article" class="fixed inset-0 z-[130] bg-[#131313] overflow-y-auto">
      <div class="min-h-screen flex flex-col max-w-3xl mx-auto relative bg-[#131313]">
        <div class="sticky top-0 z-20 flex justify-end p-4 bg-gradient-to-b from-[#131313] via-[#131313]/90 to-transparent">
          <button @click="$emit('update:modelValue', false)" class="w-10 h-10 bg-[#353534] rounded-full flex items-center justify-center text-[#c0c8ca] hover:text-[#ffffff] border border-[#40484a]/30 shadow-lg">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div class="px-6 pb-24 pt-2 flex-1 flex flex-col relative">
          <div class="flex items-center gap-2 mb-4">
            <span class="font-label text-[10px] uppercase tracking-widest text-[#00E5FF] font-bold">Article Preview</span>
          </div>
          <h1 class="font-headline text-2xl md:text-3xl font-bold text-[#e5e2e1] mb-6 leading-tight">{{ article.title }}</h1>
          
          <div class="font-body text-sm md:text-base text-[#c0c8ca] leading-relaxed space-y-5" v-html="content"></div>
          
          <div v-if="article.isPaywall" class="absolute bottom-0 left-0 w-full h-[400px] bg-gradient-to-t from-[#131313] via-[#131313]/95 to-transparent flex flex-col items-center justify-end pb-12 px-6 z-10">
            <div class="pointer-events-auto flex flex-col items-center w-full">
              <div class="w-14 h-14 bg-[#201f1f] rounded-full flex items-center justify-center mb-5 border border-[#40484a]/20">
                <span class="material-symbols-outlined text-[28px] text-[#9ecfd8]" :style="{ fontVariationSettings: '\'FILL\' 1' }">lock</span>
              </div>
              <h3 class="font-headline text-[#e5e2e1] font-bold text-lg mb-2 text-center">Continue Reading on Publisher's Site</h3>
              <button @click="$emit('browser')" class="w-full max-w-[280px] py-3 px-4 bg-gradient-to-r from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-bold rounded-xl text-xs uppercase tracking-wider shadow-[0_4px_12px_rgba(0,229,255,0.2)]">
                Open in Browser
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
defineProps<{ 
  modelValue: boolean, 
  article: any, 
  content: string 
}>();
defineEmits(['update:modelValue', 'browser']);
</script>