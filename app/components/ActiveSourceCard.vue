<template>
  <div
    class="glass-card rounded-2xl p-3 flex flex-col space-y-3 border-2 transition-all relative"
    :style="{
      borderColor: 'rgba(0, 229, 255, 0.1)',
      boxShadow: '0 0 10px rgba(0, 229, 255, 0.15)',
    }"
  >
    <div class="flex-grow space-y-1">
      <h4 class="text-[#00E5FF] font-headline text-[16px] font-bold">
        {{ source.name || getDomain(source.url) }}
      </h4>
      <p
        class="font-label text-xs text-on-surface-variant flex items-center gap-2 pb-1"
        v-if="getFullBreadcrumb(source.url)"
      >
        URL: {{ getFullBreadcrumb(source.url) }}
      </p>

      <div class="flex flex-wrap gap-2 mt-3">
        <span
          v-for="(badge, index) in getBadges(source.validationStatus)"
          :key="index"
          :class="[
            'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1',
            badge.classes,
          ]"
        >
          <span
            class="material-symbols-outlined text-[12px]"
            :class="badge.iconClasses"
            >{{ badge.icon }}</span
          >
          {{ badge.label }}
        </span>
      </div>
    </div>

    <div class="flex items-center gap-3 justify-end w-full">
      <button
        @click="$emit('suspend', source.id)"
        :disabled="isProcessing"
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface-variant/20 outline outline-1 outline-white/50 text-on-surface text-[10px] font-bold uppercase tracking-widest hover:bg-surface-variant/40 hover:text-white transition-all duration-300 disabled:opacity-50"
      >
        <span
          class="material-symbols-outlined text-[16px]"
          :style="{ fontVariationSettings: `'FILL' 1` }"
          >pause</span
        >
        <span>{{ $t("sourceManager.active_zone.btn_suspend") }}</span>
      </button>
      <button
        @click="$emit('delete', source.id)"
        :disabled="isProcessing"
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-error/50 bg-error/5 text-error text-[10px] font-bold uppercase tracking-widest hover:bg-error/15 hover:border-error/40 transition-all duration-300 disabled:opacity-50 shadow-[0_0_10px_rgba(251,0,31,0.25)]"
      >
        <span class="material-symbols-outlined text-[16px]">delete</span>
        <span>{{ $t("sourceManager.active_zone.btn_delete") }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();

defineProps<{
  source: any;
  isProcessing: boolean;
}>();

defineEmits(["suspend", "delete"]);

// Helyi helper függvények a formázáshoz
const getDomain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const getFullBreadcrumb = (url: string) => {
  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname.replace(/^www\./, "");
    const path = parsedUrl.pathname.replace(/^\/|\/$/g, "");
    if (!path) return domain;
    return `${domain} > ${path.replace(/\//g, " > ")}`;
  } catch {
    return "";
  }
};

const getBadges = (status: string) => {
  const badges = [];
  switch (status) {
    case "ACTIVE":
      badges.push({
        label: t("sourceManager.badges.verified"),
        icon: "verified_user",
        classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]",
        iconClasses: "",
      });
      badges.push({
        label: t("sourceManager.badges.rss"),
        icon: "bolt",
        classes: "bg-[#00363d]/40 text-neon-cyan outline-[#00363d]",
        iconClasses: "",
      });
      break;
    case "PENDING_DISCOVERY":
      badges.push({
        label: t("sourceManager.badges.unknown"),
        icon: "travel_explore",
        classes:
          "bg-surface-variant/50 text-on-surface-variant outline-outline-variant",
        iconClasses: "",
      });
      badges.push({
        label: t("sourceManager.badges.pending"),
        icon: "hourglass_empty",
        classes: "bg-[#3a3002]/40 text-tertiary-fixed outline-[#3a3002]",
        iconClasses: "animate-spin-slow",
      });
      break;
    case "NO_RSS_FOUND":
      badges.push({
        label: t("sourceManager.badges.verified"),
        icon: "verified_user",
        classes: "bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]",
        iconClasses: "",
      });
      badges.push({
        label: t("sourceManager.badges.direct"),
        icon: "public",
        classes:
          "bg-surface-variant/50 text-on-surface-variant outline-outline-variant",
        iconClasses: "",
      });
      break;
    case "FAILED":
    case "DOMAIN_DEAD":
      badges.push({
        label: t("sourceManager.badges.error"),
        icon: "error",
        classes: "bg-error/20 text-error outline-error/40",
        iconClasses: "",
      });
      break;
  }
  return badges;
};
</script>

<style scoped>
.animate-spin-slow {
  animation: spin 3s linear infinite;
}
.glass-card {
  background: rgba(17, 16, 16, 0.8);
  backdrop-filter: blur(12px);
}
.text-cursor {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  background-color: #00e5ff;
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
</style>
