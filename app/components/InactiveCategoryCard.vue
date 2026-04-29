<template>
  <div class="bg-surface-container-lowest p-2 rounded-xl border border-outline-variant/10 opacity-60 hover:opacity-100 transition-all duration-300 space-y-4 group">
    <div class="flex justify-between items-center">
      <div class="flex items-center gap-3">
        <span class="material-symbols-outlined text-on-surface-variant group-hover:text-primary transition-colors">{{ icon }}</span>
        <h4 class="font-headline text-lg text-on-surface">{{ title }}</h4>
      </div>
      <button @click="$emit('add')" class="bg-primary/10 text-primary hover:bg-primary-container hover:text-on-primary-container px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">
        Activate
      </button>
    </div>
    <div class="space-y-1">
      <div class="flex justify-between text-[10px] font-label text-on-surface-variant uppercase font-bold">
        <span>Weight</span>
        <span>0%</span>
      </div>
      <div class="h-1 w-full bg-surface-container rounded-full overflow-hidden">
        <div class="h-full bg-primary/10 w-0 transition-all duration-500 group-hover:w-[10%]"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ id: string; title: string; icon: string; }>();
defineEmits(['add']);
</script>