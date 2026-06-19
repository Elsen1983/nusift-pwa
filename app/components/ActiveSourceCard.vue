<template>
  <div
    class="bg-surface-container-low backdrop-blur-md rounded-2xl p-3 flex flex-col space-y-3 border border-primary-container/20 transition-all relative"
  >
    <div class="flex-grow space-y-1">
      <h4 class="text-primary-container font-headline text-[16px] font-bold">
        {{ source.name || getDomain(source.url) }}
      </h4>
      <p
        class="font-label text-xs text-on-surface-variant flex items-center gap-2 pb-1"
        v-if="getFullBreadcrumb(source.url)"
      >
        <span>URL:</span>
        <a 
          :href="source.url" 
          target="_blank" 
          rel="noopener noreferrer"
          class="hover:text-primary-container transition-colors underline decoration-on-surface-variant/30 underline-offset-2 hover:decoration-primary-container/50"
        >
          {{ getFullBreadcrumb(source.url) }}
        </a>
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
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface-variant/20 outline outline-1 outline-outline-variant text-on-surface text-[10px] font-bold uppercase tracking-widest hover:bg-surface-variant/40 hover:text-on-surface transition-all duration-300 disabled:opacity-50"
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
        class="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-error/50 bg-error/5 text-error text-[10px] font-bold uppercase tracking-widest hover:bg-error/15 hover:border-error/40 transition-all duration-300 disabled:opacity-50 shadow-sm shadow-error/20"
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
    return `${domain} / ${path.replace(/\//g, " / ")}`;
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
        classes: "bg-success/15 text-success outline-success/40",
        iconClasses: "",
      });
      badges.push({
        label: t("sourceManager.badges.rss"),
        icon: "bolt",
        classes: "bg-primary-container/15 text-primary-container outline-primary-container/40",
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
        classes: "bg-warning/15 text-warning outline-warning/40",
        iconClasses: "animate-spin-slow",
      });
      break;
    case "NO_RSS_FOUND":
      badges.push({
        label: t("sourceManager.badges.verified"),
        icon: "verified_user",
        classes: "bg-success/15 text-success outline-success/40",
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
        classes: "bg-error/10 text-error outline-error/40",
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
</style>