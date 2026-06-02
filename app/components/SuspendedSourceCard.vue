<template>
  <div class="bg-surface-container-lowest rounded-xl p-3 md:p-5 flex flex-col gap-4 outline outline-2 outline-outline-variant/80 w-full">
    <div class="flex-grow space-y-1 opacity-60 grayscale hover:grayscale-0 transition-all">
      <h4 class="font-body font-bold text-on-surface-variant text-lg">
        {{ source.name || getDomain(source.url) }}
      </h4>
      <p class="font-label text-xs text-outline flex items-center gap-2" v-if="getFullBreadcrumb(source.url)">
        {{ getFullBreadcrumb(source.url) }}
      </p>

      <div class="flex flex-wrap gap-2 mt-3">
        <span v-for="(badge, index) in getBadges(source.validationStatus)" :key="index" :class="['inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1', badge.classes]">
          <span class="material-symbols-outlined text-[12px]" :class="badge.iconClasses">{{ badge.icon }}</span>
          {{ badge.label }}
        </span>
      </div>

      <button v-if="source.validationStatus === 'FAILED' || source.validationStatus === 'NO_RSS_FOUND'" @click="$emit('rediscover', source.url)" :disabled="isProcessing" class="mt-4 flex items-center gap-1 text-[10px] font-label tracking-wider text-neon-cyan/70 hover:text-neon-cyan transition-colors uppercase outline outline-1 outline-neon-cyan/30 hover:outline-neon-cyan/80 px-2 py-1 rounded-md w-max disabled:opacity-50">
        <span class="material-symbols-outlined text-[12px]" :class="{ 'animate-spin': isProcessing }">sync</span>
        {{ $t("sourceManager.suspended_zone.btn_rediscover") }}
      </button>
    </div>

    <div class="flex items-center gap-1 justify-end w-full">
      
      <div class="relative group">
        <div 
          v-if="isQuotaFull" 
          class="absolute bottom-full right-0 mb-2 w-max max-w-[220px] sm:max-w-xs bg-surface-bright text-on-surface text-[10px] font-label px-3 py-2 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 text-center text-wrap break-words"
        >
          {{ $t("sourceManager.suspended_zone.quota_full") }}
        </div>

        <button 
          @click="$emit('activate', source.id)" 
          :disabled="isQuotaFull || isProcessing" 
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-primary-container/30 bg-primary-container/10 text-primary-container text-[10px] font-bold uppercase tracking-widest hover:bg-primary-container/20 hover:shadow-[0_0_10px_rgba(0,229,255,0.2)] transition-all duration-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span class="material-symbols-outlined text-[16px]" :style="{ fontVariationSettings: `'FILL' 1` }">play_arrow</span>
          <span>{{ $t('sourceManager.suspended_zone.btn_activate') }}</span>
        </button>
      </div>

      <button 
        @click="$emit('delete', source.id)" 
        :disabled="isProcessing" 
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-error/50 bg-error/5 text-error text-[10px] font-bold uppercase tracking-widest hover:bg-error/15 hover:border-error/40 transition-all duration-300 disabled:opacity-50 shadow-[0_0_10px_rgba(251,0,31,0.25)]"
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
  isQuotaFull: boolean;
}>();

defineEmits(['activate', 'delete', 'rediscover']);

// Helyi helper függvények
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

const getBadges = (status: string) => {
  const badges = [];
  switch (status) {
    case "ACTIVE":
      badges.push({ label: t("sourceManager.badges.verified"), icon: "verified_user", classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]", iconClasses: "" });
      badges.push({ label: t("sourceManager.badges.rss"), icon: "bolt", classes: "bg-[#00363d]/40 text-neon-cyan outline-[#00363d]", iconClasses: "" });
      break;
    case "PENDING_DISCOVERY":
      badges.push({ label: t("sourceManager.badges.unknown"), icon: "travel_explore", classes: "bg-surface-variant/50 text-on-surface-variant outline-outline-variant", iconClasses: "" });
      badges.push({ label: t("sourceManager.badges.pending"), icon: "hourglass_empty", classes: "bg-[#3a3002]/40 text-tertiary-fixed outline-[#3a3002]", iconClasses: "animate-spin-slow" });
      break;
    case "NO_RSS_FOUND":
      badges.push({ label: t("sourceManager.badges.verified"), icon: "verified_user", classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]", iconClasses: "" });
      badges.push({ label: t("sourceManager.badges.direct"), icon: "public", classes: "bg-surface-variant/50 text-on-surface-variant outline-outline-variant", iconClasses: "" });
      break;
    case "FAILED":
    case "DOMAIN_DEAD":
      badges.push({ label: t("sourceManager.badges.error"), icon: "error", classes: "bg-error/20 text-error outline-error/40", iconClasses: "" });
      break;
  }
  return badges;
};
</script>

<style scoped>
.animate-spin-slow {
  animation: spin 3s linear infinite;
}
</style>