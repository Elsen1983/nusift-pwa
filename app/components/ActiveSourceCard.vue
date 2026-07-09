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
        <span
          v-if="source.feedProvenance === 'USER_SUBMITTED'"
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1 bg-tertiary-fixed/15 text-tertiary-fixed outline-tertiary-fixed/40"
        >
          <span class="material-symbols-outlined text-[12px]">group</span>
          {{ $t('sourceManager.feed.provenance_user') }}
        </span>
        <span
          v-else-if="source.feedProvenance === 'ADMIN_CONFIRMED'"
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1 bg-primary-container/15 text-primary-container outline-primary-container/40"
        >
          <span class="material-symbols-outlined text-[12px]">shield</span>
          {{ $t('sourceManager.feed.provenance_admin') }}
        </span>
        <span
          v-if="source.openReviewRequestCount > 0"
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1 bg-warning/15 text-warning outline-warning/40"
        >
          <span class="material-symbols-outlined text-[12px]">rate_review</span>
          {{ $t('sourceManager.feed.open_reviews', { count: source.openReviewRequestCount }) }}
        </span>
      </div>

      <div
        v-if="source.rssFeedUrl || source.showFeedRecoveryTools"
        class="mt-3 rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-3 space-y-3"
      >
        <div class="space-y-1">
          <div class="text-[10px] font-label font-bold uppercase tracking-wider text-on-surface-variant">
            {{ $t("sourceManager.feed.status_label") }}
          </div>
          <div class="text-[12px] text-on-surface">
            <span v-if="source.feedVerifiedByArticles">{{ $t("sourceManager.feed.verified_live") }}</span>
            <span v-else-if="source.rssFeedUrl">{{ $t("sourceManager.feed.not_verified_yet") }}</span>
            <span v-else>{{ $t("sourceManager.feed.no_feed_saved") }}</span>
          </div>
          <a
            v-if="source.rssFeedUrl"
            :href="source.rssFeedUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="block break-all text-[12px] text-primary-container underline decoration-primary-container/40 underline-offset-2 hover:decoration-primary-container/70"
          >
            {{ source.rssFeedUrl }}
          </a>
        </div>

        <div v-if="source.detectedSections?.length" class="space-y-1">
          <div class="text-[10px] font-label font-bold uppercase tracking-wider text-on-surface-variant">
            {{ $t("sourceManager.feed.detected_sections") }}
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="section in source.detectedSections"
              :key="section"
              class="rounded bg-surface-container-highest px-2 py-1 text-[10px] uppercase tracking-wide text-on-surface-variant"
            >
              {{ section }}
            </span>
          </div>
        </div>

        <div v-if="source.showFeedRecoveryTools && source.feedCandidates?.length" class="space-y-2">
          <div class="text-[10px] font-label font-bold uppercase tracking-wider text-on-surface-variant">
            {{ $t("sourceManager.feed.candidate_feeds") }}
          </div>
          <div class="flex flex-col gap-2">
            <button
              v-for="candidate in source.feedCandidates"
              :key="candidate"
              @click="$emit('saveFeed', { subscriptionId: source.id, feedUrl: candidate })"
              :disabled="isProcessing"
              class="rounded-lg border border-primary-container/30 bg-primary-container/10 px-3 py-2 text-left text-[11px] text-primary-container transition-colors hover:bg-primary-container/20 disabled:opacity-50"
            >
              {{ candidate }}
            </button>
          </div>
        </div>

        <div v-if="source.showFeedRecoveryTools" class="space-y-2">
          <div class="text-[10px] font-label font-bold uppercase tracking-wider text-on-surface-variant">
            {{ $t("sourceManager.feed.manual_label") }}
          </div>
          <div class="flex flex-col gap-2 sm:flex-row">
            <input
              v-model="manualFeedUrl"
              type="url"
              inputmode="url"
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-lg border border-outline-variant/30 bg-surface-container-highest px-3 py-2 text-[12px] text-on-surface outline-none focus:border-primary-container/50"
              :placeholder="$t('sourceManager.feed.manual_placeholder')"
            />
            <button
              @click="emitManualFeed"
              :disabled="isProcessing || !manualFeedUrl.trim()"
              class="rounded-lg border border-primary-container/30 bg-primary-container/10 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-primary-container transition-colors hover:bg-primary-container/20 disabled:opacity-50"
            >
              {{ $t("sourceManager.feed.save_feed") }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 justify-end w-full flex-wrap">
      <button
        @click="$emit('requestReview', source.id)"
        :disabled="isProcessing || source.userHasOpenReviewRequest"
        :title="source.userHasOpenReviewRequest ? $t('sourceManager.feed.review_already_requested') : $t('sourceManager.feed.request_review')"
        class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-warning/10 outline outline-1 outline-warning/30 text-warning text-[10px] font-bold uppercase tracking-widest hover:bg-warning/20 transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span class="material-symbols-outlined text-[14px]">rate_review</span>
        <span>{{ source.userHasOpenReviewRequest ? $t('sourceManager.feed.review_already_requested') : $t('sourceManager.feed.request_review') }}</span>
      </button>
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
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  source: any;
  isProcessing: boolean;
}>();

const emit = defineEmits(["suspend", "delete", "saveFeed", "requestReview"]);

const manualFeedUrl = ref("");

watch(
  () => props.source?.rssFeedUrl,
  (value) => {
    manualFeedUrl.value = value || "";
  },
  { immediate: true },
);

const emitManualFeed = () => {
  const feedUrl = manualFeedUrl.value.trim();
  if (!feedUrl) return;
  emit("saveFeed", { subscriptionId: props.source.id, feedUrl });
};

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
