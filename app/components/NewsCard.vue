<template>
  <article class="bg-surface-container rounded-2xl p-3.5 relative group transition-all hover:bg-surface-container-high overflow-visible">
    
    <div 
      v-if="activeOverlay === article.id"
      class="absolute inset-0 bg-[#1c1b1b]/95 backdrop-blur-sm z-[60] rounded-2xl p-5 flex flex-col justify-center transition-opacity duration-200"
    >
      <h3 class="font-headline text-[#00E5FF] font-bold text-sm mb-3 uppercase tracking-wider border-b border-[#00E5FF]/20 pb-2">Key Signal Points</h3>
      <ul class="space-y-2.5">
        <li v-for="point in article.signals" :key="point" class="flex items-start gap-2">
          <span class="material-symbols-outlined text-[14px] text-primary-container mt-0.5" :style="{ fontVariationSettings: '\'FILL\' 1' }">adjust</span>
          <span class="text-xs font-body text-on-surface-variant leading-tight">{{ point }}</span>
        </li>
      </ul>
    </div>

    <div class="flex items-center justify-between mb-1.5">
      <div class="flex items-center gap-3">
        <span class="font-label text-[9px] uppercase tracking-widest text-on-surface-variant">{{ article.date }}</span>
        <div class="flex items-center gap-1 bg-tertiary-container/10 px-1.5 py-0.5 rounded-full">
          <span class="material-symbols-outlined text-[10px] text-tertiary-container" :style="{ fontVariationSettings: '\'FILL\' 1' }">star</span>
          <span class="font-label text-[9px] font-bold text-tertiary-container">{{ article.score }}/10</span>
        </div>
        <div v-if="article.isPaywall" class="flex items-center gap-1 bg-surface-container-highest px-1.5 py-0.5 rounded-full ml-1 border border-primary-container/20">
          <span class="material-symbols-outlined text-[10px] text-primary-container" :style="{ fontVariationSettings: '\'FILL\' 1' }">lock</span>
          <span class="font-label text-[8px] font-bold text-primary-container uppercase tracking-tighter">Paywall</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button @click="$emit('readNow', article)" class="text-primary-container font-bold text-[10px] uppercase tracking-wider hover:underline">Read Now</button>
        <button @click.stop="$emit('toggleMenu', article.id)" class="material-symbols-outlined text-on-surface-variant text-base bg-[#353534]/50 rounded-full flex items-center justify-center hover:bg-surface-bright transition-colors w-8 h-8 p-0 relative z-[65]">
           {{ activeOverlay === article.id ? 'close' : 'more_vert' }}
        </button>
      </div>
    </div>
    
    <h2 class="font-headline font-bold text-on-surface leading-tight mb-2 text-base">{{ article.title }}</h2>
    
    <div class="flex items-end justify-between gap-4 pt-2 border-t border-outline-variant/10">
      <div class="w-full">
        <span class="text-[9px] font-label text-outline uppercase tracking-wider mb-1 block">{{ article.source }}</span>
        <div class="flex items-center justify-between w-full mb-0.5">
          <h4 class="text-[9px] font-bold text-ai-reasoning-blue uppercase tracking-wider flex items-center gap-1">
            <span class="material-symbols-outlined text-[11px]">auto_awesome</span> AI Reasoning
          </h4>
          <div class="flex flex-wrap justify-end gap-1.5">
            <button v-for="tag in article.tags" :key="tag" class="px-2 py-0.5 bg-surface-container-highest rounded text-[8px] font-bold text-ai-reasoning-blue hover:bg-surface-bright transition-colors uppercase tracking-tighter">
              {{ tag }}
            </button>
          </div>
        </div>
        <p class="text-[10px] font-body text-on-surface-variant leading-tight line-clamp-2">{{ article.reasoning }}</p>
      </div>
    </div>

    <div 
      v-if="activeActionMenu === article.id"
      class="absolute top-12 right-3 w-56 bg-surface-container-highest border border-outline-variant/20 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[70] flex flex-col py-2"
    >
      <button @click.stop="$emit('openOverlay', article.id)" class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">format_list_bulleted</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">View Signal Points</span>
      </button>
      <button class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">star</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Save as Favourite</span>
      </button>
      <button class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">schedule</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Read Later</span>
      </button>
      <button class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">share</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Share</span>
      </button>
      <div class="h-px bg-outline-variant/20 w-full my-1"></div>
      <button class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">block</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Not Interested</span>
      </button>
      <button class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group">
        <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">reviews</span>
        <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Personal Rating</span>
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
// Define what data the parent needs to pass in
defineProps<{
  article: any;
  activeActionMenu: number | null;
  activeOverlay: number | null;
}>();

// Define what events this component can send back to the parent
defineEmits(['readNow', 'toggleMenu', 'openOverlay']);
</script>