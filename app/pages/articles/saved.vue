<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-6 pb-24 overflow-hidden">
    <section class="px-2 space-y-2">
      <div class="flex items-center gap-3">
        <span class="material-symbols-outlined text-primary-container text-2xl">bookmark</span>
        <h1 class="font-headline text-2xl font-bold text-on-surface tracking-tight">
          {{ $t("savedPage.title") }}
        </h1>
      </div>
      <p class="text-on-surface-variant text-sm font-body pl-[40px]">
        {{ $t("savedPage.description") }}
      </p>
    </section>

    <section class="space-y-3">
      <div
        class="rounded-3xl border border-outline-variant/10 bg-surface-container-low shadow-lg overflow-hidden"
      >
        <button class="w-full flex items-center justify-between p-4 text-left" @click="open.favourites = !open.favourites">
          <div>
            <div class="font-body text-[15px] font-medium text-on-surface">{{ $t("savedPage.sections.favourites") }}</div>
            <div class="text-xs text-on-surface-variant">{{ favouriteArticles.length }} {{ $t("savedPage.items") }}</div>
          </div>
          <span class="material-symbols-outlined transition-transform" :class="open.favourites ? 'rotate-180' : ''">expand_more</span>
        </button>
        <div v-show="open.favourites" class="px-4 pb-4 space-y-3">
          <div
            v-for="item in favouriteArticles"
            :key="item.id"
            class="rounded-2xl border border-primary-container/25 bg-primary-container/5 p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="font-body text-[15px] font-medium text-on-surface break-words">{{ item.title }}</div>
                <div class="text-sm text-on-surface-variant mt-1 break-words">{{ item.source }}</div>
              </div>
              <button class="p-2 rounded-full hover:bg-error/10 text-on-surface-variant hover:text-error">
                <span class="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          </div>
          <div v-if="!favouriteArticles.length" class="rounded-2xl border border-dashed border-outline-variant/20 p-6 text-sm text-on-surface-variant">
            {{ $t("savedPage.empty.favourites") }}
          </div>
        </div>
      </div>

      <div
        class="rounded-3xl border border-outline-variant/10 bg-surface-container-low shadow-lg overflow-hidden"
      >
        <button class="w-full flex items-center justify-between p-4 text-left" @click="open.readLater = !open.readLater">
          <div>
            <div class="font-body text-[15px] font-medium text-on-surface">{{ $t("savedPage.sections.readLater") }}</div>
            <div class="text-xs text-on-surface-variant">{{ readLaterArticles.length }} {{ $t("savedPage.items") }}</div>
          </div>
          <span class="material-symbols-outlined transition-transform" :class="open.readLater ? 'rotate-180' : ''">expand_more</span>
        </button>
        <div v-show="open.readLater" class="px-4 pb-4 space-y-3">
          <div
            v-for="item in readLaterArticles"
            :key="item.id"
            class="rounded-2xl border border-outline-variant/15 bg-surface-container p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="font-body text-[15px] font-medium text-on-surface break-words">{{ item.title }}</div>
                <div class="text-sm text-on-surface-variant mt-1 break-words">{{ item.source }}</div>
              </div>
              <button class="p-2 rounded-full hover:bg-error/10 text-on-surface-variant hover:text-error">
                <span class="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          </div>
          <div v-if="!readLaterArticles.length" class="rounded-2xl border border-dashed border-outline-variant/20 p-6 text-sm text-on-surface-variant">
            {{ $t("savedPage.empty.readLater") }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: "app-layout" });

useHead({
  title: "Saved | NuSift",
});

const open = reactive({ favourites: true, readLater: false });

const favouriteArticles = ref<{ id: string; title: string; source: string }[]>([]);
const readLaterArticles = ref<{ id: string; title: string; source: string }[]>([]);
</script>
