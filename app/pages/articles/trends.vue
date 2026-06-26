<template>
  <div class="px-4 py-8 max-w-2xl mx-auto space-y-6 pb-24 overflow-hidden">
    <section class="px-2 space-y-2">
      <div class="flex items-center gap-3">
        <span class="material-symbols-outlined text-primary-container text-2xl">insights</span>
        <h1 class="font-headline text-2xl font-bold text-on-surface tracking-tight">
          {{ $t("trendsPage.title") }}
        </h1>
      </div>
      <p class="text-on-surface-variant text-sm font-body pl-[40px]">
        {{ $t("trendsPage.description") }}
      </p>
    </section>

    <section class="space-y-3">
      <div
        class="rounded-3xl border border-outline-variant/10 bg-surface-container-low shadow-lg overflow-hidden"
      >
        <div class="flex flex-col items-center justify-center py-16 px-6 text-center">
          <span
            class="material-symbols-outlined text-on-surface-variant/40 text-6xl mb-4"
          >
            trending_up
          </span>
          <h3 class="font-headline text-lg font-bold text-on-surface tracking-tight mb-2">
            {{ $t("trendsPage.emptyState.title") }}
          </h3>
          <p class="text-on-surface-variant text-sm font-body max-w-xs">
            {{ $t("trendsPage.emptyState.description") }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: "app-layout" });

useHead({
  title: "Trends | NuSift",
});
</script>
