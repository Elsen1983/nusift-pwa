<template>
  <div class="bg-surface-container-lowest rounded-xl p-3 md:p-5 flex flex-col gap-4 border border-warning/30 w-full relative overflow-hidden">
    <div class="absolute top-0 right-0 w-32 h-32 bg-warning/5 blur-3xl rounded-full pointer-events-none"></div>

    <div class="flex-grow space-y-2 relative z-10">
      
      <div class="flex flex-col items-start gap-2">
        <div>
          <h4 class="font-body font-bold text-warning text-lg">
            {{ source.name || getDomain(source.url) }}
          </h4>
          <p class="font-label text-xs text-on-surface-variant flex items-center gap-2 mt-0.5" v-if="getFullBreadcrumb(source.url)">
            URL: {{ getFullBreadcrumb(source.url) }}
          </p>
        </div>
        
        <span class="inline-flex items-center gap-1 px-2 py-1 mt-1 rounded text-[10px] font-label border bg-error/10 text-error border-error/30">
          <span class="material-symbols-outlined text-[12px]">shield_lock</span>
          {{ $t('sourceManager.badges.publisher_blocked') }}
        </span>
      </div>

      <div class="mt-3 bg-warning/10 border border-warning/20 rounded-lg p-3 flex gap-3 items-start">
        <span class="material-symbols-outlined text-warning text-lg shrink-0 mt-0.5">smart_toy</span>
        <p class="text-[12px] font-body text-on-surface-variant leading-relaxed">
          {{ $t('sourceManager.restricted_zone.banner_p1') }}
          <strong class="text-warning">{{ $t('sourceManager.restricted_zone.banner_highlight') }}</strong>
          {{ $t('sourceManager.restricted_zone.banner_p2') }}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-3 justify-end w-full relative z-10 pt-2">
      <button 
        @click="$emit('delete', source.id)" 
        :disabled="isProcessing" 
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-error/50 bg-error/5 text-error text-[10px] font-bold uppercase tracking-widest hover:bg-error/15 hover:border-error/40 transition-all duration-300 disabled:opacity-50"
      >
        <span class="material-symbols-outlined text-[16px]">delete</span>
        <span>{{ $t('sourceManager.active_zone.btn_delete') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

defineProps<{
  source: any;
  isProcessing: boolean;
}>();

defineEmits(['delete']);

const getDomain = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } 
  catch { return url; }
};

const getFullBreadcrumb = (url: string) => {
  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname.replace(/^www\./, "");
    const path = parsedUrl.pathname.replace(/^\/|\/$/g, "");
    if (!path) return domain;
    return `${domain} > ${path.replace(/\//g, " > ")}`;
  } catch { return ""; }
};
</script>