<template>
  <article
    class="bg-surface-container rounded-2xl p-2.5 relative group transition-all hover:bg-surface-container-high overflow-visible outline outline-1 outline-primary-container/30"
  >
    <div
      v-if="activeOverlay === article.id"
      class="absolute inset-0 bg-surface-container-highest/95 backdrop-blur-md z-[60] rounded-2xl p-5 pt-2 mt-0 flex flex-col justify-center transition-opacity duration-200"
    >
      <h3
        class="relative pb-1 mb-2 text-sm font-bold uppercase font-headline text-semantic-ai after:content-[''] after:absolute after:bottom-0 after:left-0 after:w-[75%] after:h-[1px] after:bg-semantic-ai/30"
      >
        {{ $t("newsCard.key_signals") }}
      </h3>
      <ul class="space-y-1">
        <li
          v-for="point in article.signals"
          :key="point"
          class="flex items-start gap-2"
        >
          <span
            class="material-symbols-outlined text-[14px] text-semantic-ai mt-0.5"
            :style="{ fontVariationSettings: '\'FILL\' 1' }"
            >adjust</span
          >
          <span
            class="text-xs font-body text-on-surface-variant leading-tight"
            >{{ point }}</span
          >
        </li>
      </ul>
    </div>

    <div class="flex items-center justify-between mb-1.5">
      <div class="flex items-center gap-3">
        <span
          class="font-label text-[10px] uppercase tracking-widest text-on-surface-variant"
          >{{ formattedDate }}</span
        >
        <!-- Rating Badge -->
        <div
          class="flex items-center gap-1 bg-semantic-rating/10 px-1.5 py-0.5 rounded-full"
        >
          <span
            class="material-symbols-outlined text-[12px] text-semantic-rating"
            :style="{ fontVariationSettings: '\'FILL\' 1' }"
            >star</span
          >
          <span class="font-label text-[11px] font-bold text-semantic-rating"
            >{{ article.score }}/10</span
          >
        </div>
        <!-- Paywall Badge -->
        <div
          v-if="article.isPaywall"
          class="flex items-center gap-1 bg-semantic-paywall/10 px-1.5 py-0.5 rounded-full mr-1 border border-semantic-paywall/20"
        >
          <span
            class="material-symbols-outlined text-[12px] text-semantic-paywall"
            :style="{ fontVariationSettings: '\'FILL\' 1' }"
            >lock</span
          >
          <span
            class="font-label text-[10px] font-bold text-semantic-paywall uppercase tracking-tighter"
            >{{ $t("newsCard.paywall") }}</span
          >
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          @click="$emit('readNow', article)"
          class="text-primary-container font-bold text-[12px] uppercase tracking-wider hover:underline"
        >
          {{ $t("newsCard.read_now") }}
        </button>
        <button
          @click.stop="$emit('toggleMenu', article.id)"
          class="material-symbols-outlined text-base text-on-surface bg-surface-container-high rounded-full flex items-center justify-center hover:bg-surface-bright transition-colors w-8 h-8 p-0 relative z-[65] border border-solid border-outline-variant/50"
        >
          {{ activeOverlay === article.id ? "close" : "more_vert" }}
        </button>
      </div>
    </div>

    <h2
      class="font-headline font-bold text-on-surface leading-tight mb-1 text-base"
    >
      {{ article.title }}
    </h2>

    <div
      class="flex items-end justify-between gap-4 border-t border-outline-variant/10"
    >
      <div class="w-full">
        <span
          class="text-[12px] font-label text-outline uppercase tracking-wider mb-1 block"
          >{{ article.source }}</span
        >
        <div class="flex items-center justify-between w-full mb-0.5">
          <!-- AI Reasoning Header -->
          <h4
            class="text-[12px] font-bold text-semantic-ai uppercase tracking-wider flex items-center gap-1"
          >
            <span class="material-symbols-outlined text-[11px]"
              >auto_awesome</span
            >
            {{ $t("newsCard.ai_reasoning") }}
          </h4>
          <div class="flex flex-wrap justify-end gap-1.5">
            <!-- AI Tag Chips -->
            <button
              v-for="tag in article.tags"
              :key="tag"
              class="px-1 py-0 pt-0.5 bg-surface-container-highest rounded text-[10px] text-semantic-ai-variant hover:bg-surface-bright transition-colors uppercase"
            >
              {{ tag }}
            </button>
          </div>
        </div>
        <p
          class="text-[12px] font-body text-on-surface-variant leading-tight line-clamp-2"
        >
          {{ article.reasoning }}
        </p>
      </div>
    </div>

    <div
      v-if="activeActionMenu === article.id"
      class="absolute top-12 right-3 w-56 bg-surface-container-highest border border-outline-variant/30 rounded-xl shadow-2xl z-[70] flex flex-col py-2"
    >
      <button
        @click.stop="$emit('openOverlay', article.id)"
        class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container transition-colors"
          >format_list_bulleted</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-on-surface transition-colors"
          >{{ $t("newsCard.menu.view_signals") }}</span
        >
      </button>

      <button
        class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container transition-colors"
          >star</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-on-surface transition-colors"
          >{{ $t("newsCard.menu.save_favourite") }}</span
        >
      </button>

      <button
        class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container transition-colors"
          >schedule</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-on-surface transition-colors"
          >{{ $t("newsCard.menu.read_later") }}</span
        >
      </button>

      <button
        class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container transition-colors"
          >share</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-on-surface transition-colors"
          >{{ $t("newsCard.menu.share") }}</span
        >
      </button>

      <button
        @click.stop="$emit('openRating', article.id)"
        class="flex items-center gap-4 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container transition-colors"
          >reviews</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-on-surface transition-colors"
          >{{ $t("newsCard.menu.personal_rating") }}</span
        >
      </button>

      <div class="h-px bg-outline-variant/40 w-full my-1"></div>

      <button
        class="flex items-center gap-4 px-4 py-2 hover:bg-error/10 transition-colors text-left w-full group"
      >
        <span
          class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-error transition-colors"
          >block</span
        >
        <span
          class="text-xs font-bold text-on-surface-variant group-hover:text-error transition-colors"
          >{{ $t("newsCard.menu.not_interested") }}</span
        >
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatDateByLocale } from "~/utils/date";

// Define what data the parent needs to pass in
const props = defineProps<{
  article: any;
  activeActionMenu: number | null;
  activeOverlay: number | null;
}>();

// Define what events this component can send back to the parent
defineEmits(["readNow", "toggleMenu", "openOverlay", "openRating"]);

const { locale } = useI18n();

const formattedDate = computed(() =>
  formatDateByLocale(props.article?.date || "", locale.value),
);
</script>
