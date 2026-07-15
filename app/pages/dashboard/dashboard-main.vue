<template>
  <div>
    <!-- REFACTORED: Removed hardcoded #131313 gradients and black borders -->
    <div class="fixed top-[60px] inset-x-0 z-[90]">
      <div
        class="mx-auto w-full max-w-2xl bg-surface/95 backdrop-blur-md shadow-sm border-b border-outline-variant/30"
      >
        <div class="box-border flex w-full min-w-0 flex-col gap-3 px-4 py-3 relative">
          <div class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
            <div
              class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
              v-click-outside="() => (isDateDropdownOpen = false)"
            >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.date_label") }}</span
            >
            <!-- REFACTORED: Removed #00E5FF outline/border, using primary-container -->
            <div
              @click="toggleDateDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                    >{{
                      $t("dashboard.filters.dates." + currentSelectedDateKey)
                    }}</span
                  >
                  <span
                    class="material-symbols-outlined text-[18px] text-primary-container flex-shrink-0 ml-2"
                    >expand_more</span
                  >
                </div>
              </div>
            </div>
            <div
              v-show="isDateDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg space-y-1 p-3 pt-2"
            >
              <div
                v-for="option in visibleDateOptions"
                :key="option.key"
                @click="selectDate(option.key)"
                class="text-[13px] font-bold text-on-surface-variant/90 transition-colors py-1 hover:text-primary-container cursor-pointer"
              >
                {{ $t("dashboard.filters.dates." + option.key) }}
                <span
                  v-if="option.isPro"
                  class="material-symbols-outlined text-[12px] ml-1 align-text-bottom text-primary-container/70"
                >
                  workspace_premium
                </span>
              </div>
            </div>
          </div>

            <div
              class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
              v-click-outside="() => (isCategoryDropdownOpen = false)"
            >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.categories_label") }}</span
            >
            <!-- REFACTORED: Removed #00E5FF outline/border -->
            <div
              @click="toggleCategoryDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span
                    class="font-label font-medium text-on-surface-variant truncate"
                  >
                    {{
                      selectedCategories.length > 0
                        ? localizedSelectedCategories
                        : $t("dashboard.header.all_categories")
                    }}
                  </span>
                  <span
                    class="material-symbols-outlined text-[18px] text-primary-container flex-shrink-0 ml-2"
                    >expand_more</span
                  >
                </div>
              </div>
            </div>
            <div
              v-show="isCategoryDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg flex flex-col gap-y-2 p-3 pt-2 max-h-48 overflow-y-auto"
            >
              <!-- REFACTORED: text-[#00E5FF] changed to text-primary-container -->
              <div
                @click="selectCategory('All Categories')"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.length === 0
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/100',
                ]"
              >
                {{ $t("dashboard.header.all_categories") }}
              </div>
              <div
                v-for="cat in availableCategories"
                :key="cat.key"
                @click="selectCategory(cat.value)"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedCategories.includes(cat.value)
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/90',
                ]"
              >
                {{ $t("dashboard.filters.categories." + cat.key) }}
              </div>
            </div>
          </div>
          </div>

          <div class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_6rem] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <div
              class="flex-1 flex flex-col gap-1.5 min-w-0 relative"
              v-click-outside="() => (isSourceDropdownOpen = false)"
            >
            <span
              class="font-label text-[10px] uppercase tracking-wider font-bold text-on-surface-variant"
              >{{ $t("dashboard.header.sources_label") }}</span
            >
            <div
              @click="toggleSourceDropdown"
              class="relative flex justify-between items-center bg-surface-container-highest px-3 py-1.5 rounded-lg hover:bg-surface-bright transition-colors cursor-pointer text-xs h-[36px] border border-solid border-primary-container/30 outline outline-1 outline-primary-container/20"
            >
              <div class="flex flex-col w-full h-full justify-center min-w-0">
                <div class="flex justify-between items-center w-full min-w-0">
                  <span class="font-label font-medium text-on-surface-variant truncate">
                    {{
                      selectedSources.length > 0
                        ? localizedSelectedSources
                        : $t("dashboard.header.all_sources")
                    }}
                  </span>
                  <span
                    class="material-symbols-outlined text-[18px] text-primary-container flex-shrink-0 ml-2"
                    >expand_more</span
                  >
                </div>
              </div>
            </div>
            <div
              v-show="isSourceDropdownOpen"
              class="absolute top-full mt-1 left-0 w-full z-[60] shadow-xl bg-surface-container-highest border border-outline-variant/30 rounded-lg flex flex-col gap-y-2 p-3 pt-2 max-h-56 overflow-y-auto"
            >
              <div
                @click="selectSource('All Sources')"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedSources.length === 0
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/100',
                ]"
              >
                {{ $t("dashboard.header.all_sources") }}
              </div>
              <div
                v-for="source in availableSources"
                :key="source.id"
                @click="selectSource(source.id)"
                :class="[
                  'text-[13px] font-bold hover:text-primary-container transition-colors py-0.5 cursor-pointer',
                  selectedSources.includes(source.id)
                    ? 'text-primary-container'
                    : 'text-on-surface-variant/90',
                ]"
              >
                {{ source.name }}
              </div>
            </div>
          </div>

            <div class="flex w-24 shrink-0 items-center justify-center sm:w-28">
            <!-- REFACTORED: Removed hardcoded shadow and #00E5FF, injected CSS variables -->
            <button
              @click="applyFilters"
              :disabled="!hasPendingFilters || isRefreshing"
              :class="[
                'flex w-full justify-center items-center gap-1.5 px-2 rounded-lg transition-all h-[36px] border min-w-0 sm:px-3',
                hasPendingFilters
                  ? 'bg-surface-container-highest text-primary-container border-primary-container/30 shadow-[0_0_12px_rgb(var(--color-primary-container)/0.15)] hover:bg-surface-bright'
                  : 'bg-surface-container-highest text-on-surface-variant/50 border-transparent disabled:opacity-50 disabled:cursor-not-allowed',
              ]"
            >
              <span
                :class="[
                  'material-symbols-outlined text-[18px]',
                  { 'animate-spin': isRefreshing },
                ]"
                >refresh</span
              >
              <span class="font-label font-bold text-[11px] sm:text-xs">{{ $t('dashboard.header.refresh_label') }}</span>
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <main
      class="mx-auto w-full max-w-2xl box-border space-y-2 px-4 pt-[165px]"
      @click="closeArticleInteractions"
    >
      <div
        v-if="!isLoading && filteredArticles.length === 0"
        class="rounded-2xl border border-dashed border-outline-variant/40 bg-surface-container px-5 py-8 text-center"
      >
        <h2 class="font-headline text-base font-bold text-on-surface">
          {{ $t("dashboard.empty.title") }}
        </h2>
        <p class="mt-2 text-sm text-on-surface-variant">
          {{ $t("dashboard.empty.description") }}
        </p>
      </div>

      <div
        v-if="toast.show"
        class="fixed bottom-4 left-1/2 z-[120] w-[min(92vw,28rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md"
        :class="toastClass"
      >
        <div class="flex items-start gap-3">
          <span class="material-symbols-outlined text-[20px] mt-0.5">{{ toastIcon }}</span>
          <p class="text-sm font-medium leading-snug">{{ toast.message }}</p>
        </div>
      </div>

      <div :class="isRefreshing ? 'pointer-events-none opacity-60' : ''">
        <NewsCard
          v-for="article in paginatedArticles"
          :key="article.id"
          :article="article"
          :activeActionMenu="activeActionMenu"
          :activeOverlay="activeOverlay"
          @readNow="handleReadNow"
          @toggleMenu="toggleActionMenu"
          @openOverlay="openOverlay"
          @openRating="openRatingModal"
          style="margin-bottom: 0.75rem !important;"
        />
      </div>

      <section v-if="totalPages > 1" class="w-full py-4 flex justify-center">
        <div class="flex w-full md:w-3/4 items-center gap-1 md:gap-1.5 rounded-2xl border border-outline-variant/15 bg-surface-container/90 px-1.5 py-1.5 md:px-2.5 md:py-2 shadow-[0_4px_14px_rgba(0,0,0,0.16)] backdrop-blur-sm">
          <button
            type="button"
            class="inline-flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl border border-outline-variant/10 bg-surface-container-high/70 text-on-surface-variant transition-all duration-200 hover:border-primary-container/25 hover:bg-primary-container/10 hover:text-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="currentPage === 1"
            @click="setPage(currentPage - 1)"
            aria-label="Previous page"
          >
            <span class="material-symbols-outlined text-[16px] md:text-[18px]">chevron_left</span>
          </button>

          <div
            class="flex flex-1 items-center gap-0.5 md:gap-1 text-[11px] md:text-xs font-medium px-0.5 md:px-1"
            :class="totalPages <= 5 ? 'justify-center' : 'justify-between'"
          >
            <template v-for="(item, index) in visiblePageItems" :key="`${item}-${index}`">
              <button
                v-if="item !== 'ellipsis'"
                type="button"
                class="min-w-8 h-8 md:min-w-9 md:h-9 px-2 md:px-3 rounded-xl border border-transparent transition-all duration-200"
                :class="
                  item === currentPage
                    ? 'bg-primary-container text-on-primary-container font-bold shadow-[0_0_10px_rgb(var(--color-primary-container)/0.16)]'
                    : 'text-on-surface-variant hover:text-primary-container hover:bg-primary-container/10 hover:border-primary-container/15'
                "
                @click="setPage(item as number)"
              >
                {{ item }}
              </button>
              <span
                v-else
                class="px-0.5 md:px-1.5 text-on-surface-variant/60 select-none"
                aria-hidden="true"
              >
                …
              </span>
            </template>
          </div>

          <button
            type="button"
            class="inline-flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl border border-outline-variant/10 bg-surface-container-high/70 text-on-surface-variant transition-all duration-200 hover:border-primary-container/25 hover:bg-primary-container/10 hover:text-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="currentPage === totalPages"
            @click="setPage(currentPage + 1)"
            aria-label="Next page"
          >
            <span class="material-symbols-outlined text-[16px] md:text-[18px]">chevron_right</span>
          </button>
        </div>
      </section>

      <div
        v-if="showAdminPipelinePanel"
        class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4 space-y-4"
      >
        <div v-if="false" class="flex flex-wrap items-center gap-2">
          <button
            @click="reimportRss"
            :disabled="isImportingRss"
            class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isImportingRss ? "Importing..." : "Reimport RSS" }}
          </button>
          <button
            @click="fixRssStatus"
            :disabled="isFixingRssStatus"
            class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isFixingRssStatus ? "Fixing..." : "Fix RSS status" }}
          </button>
          <button
            @click="backfillArticleCategories"
            :disabled="isBackfillingArticleCategories"
            class="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-bold text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isBackfillingArticleCategories ? "Backfilling..." : "Backfill article categories" }}
          </button>
          <button
            @click="normalizeHttpSources"
            :disabled="isNormalizingHttpSources"
            class="rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-2 text-sm font-bold text-violet-100 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isNormalizingHttpSources ? "Normalizing..." : "Normalize HTTP sources" }}
          </button>
          <button
            @click="auditHttpSourceMerge"
            :disabled="isAuditingHttpSourceMerge"
            class="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-4 py-2 text-sm font-bold text-indigo-100 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isAuditingHttpSourceMerge ? "Auditing..." : "Audit HTTP source merges" }}
          </button>
          <button
            @click="deleteSafeHttpDuplicates"
            :disabled="isDeletingSafeHttpDuplicates"
            class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm font-bold text-rose-100 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isDeletingSafeHttpDuplicates ? "Deleting..." : "Delete safe HTTP duplicates" }}
          </button>
          <button
            @click="auditScopedRss"
            :disabled="isAuditingScopedRss"
            class="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/10 px-4 py-2 text-sm font-bold text-fuchsia-100 transition-colors hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isAuditingScopedRss ? "Building..." : "Build scoped source report" }}
          </button>
          <button
            @click="normalizeScopedSources"
            :disabled="isNormalizingScopedSources"
            class="rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-2 text-sm font-bold text-violet-100 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isNormalizingScopedSources ? "Normalizing..." : "Normalize source URLs" }}
          </button>
          <button
            @click="pruneScopedSources"
            :disabled="isPruningScopedSources"
            class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm font-bold text-rose-100 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ isPruningScopedSources ? "Pruning..." : "Prune invalid scoped sources" }}
          </button>
        </div>

        <div
          v-if="false && scopedSourceAuditSummary"
          class="rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3"
        >
          <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Scoped source report
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Last report: {{ formatLogTime(scopedSourceAuditSummary.generatedAt) }} · {{ scopedSourceAuditSummary.totalSubPathSources }} sub-path source(s)
              </p>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div class="rounded-lg bg-surface-container-highest px-3 py-2 text-on-surface-variant">
              <span class="block text-[10px] uppercase tracking-wide">Keep</span>
              <span class="mt-1 block text-sm font-bold text-on-surface">{{ scopedSourceAuditSummary.keep }}</span>
            </div>
            <div class="rounded-lg bg-surface-container-highest px-3 py-2 text-violet-200">
              <span class="block text-[10px] uppercase tracking-wide">Normalize</span>
              <span class="mt-1 block text-sm font-bold">{{ scopedSourceAuditSummary.normalizeToHttps }}</span>
            </div>
            <div class="rounded-lg bg-surface-container-highest px-3 py-2 text-rose-200">
              <span class="block text-[10px] uppercase tracking-wide">Delete</span>
              <span class="mt-1 block text-sm font-bold">{{ scopedSourceAuditSummary.candidateDeleteInvalidSubpath }}</span>
            </div>
            <div class="rounded-lg bg-surface-container-highest px-3 py-2 text-fuchsia-200">
              <span class="block text-[10px] uppercase tracking-wide">Shared root</span>
              <span class="mt-1 block text-sm font-bold">{{ scopedSourceAuditSummary.candidateSharedRootOnly }}</span>
            </div>
            <div class="rounded-lg bg-surface-container-highest px-3 py-2 text-amber-200">
              <span class="block text-[10px] uppercase tracking-wide">Manual review</span>
              <span class="mt-1 block text-sm font-bold">{{ scopedSourceAuditSummary.needsManualReview }}</span>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-3 rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Manual pipeline trigger
              </h3>
              <span
                class="rounded-full border border-primary-container/30 bg-primary-container/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-container"
              >
                {{ isDev ? "Dev" : "Admin" }}
              </span>
            </div>
            <p class="mt-1 text-xs text-on-surface-variant">
              Manually run the news pipeline and refresh the feed.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="showFullDevTools"
              @click="runHardCaseQueue"
              :disabled="isHardCaseQueueRunning"
              class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isHardCaseQueueRunning ? "Running..." : "Run hard-case queue" }}
            </button>
            <button
              @click="enrichExistingArticles"
              :disabled="isEnrichingExistingArticles"
              class="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-bold text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isEnrichingExistingArticles ? "Enriching..." : "Enrich existing articles" }}
            </button>
            <button
              @click="runManualPipeline"
              :disabled="isPipelineRunning"
              class="rounded-lg bg-primary-container px-4 py-2 text-sm font-bold text-on-primary-container transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isPipelineRunning ? "Running..." : "Run pipeline" }}
            </button>
          </div>
        </div>

        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h4 class="font-headline text-sm font-bold text-on-surface">
                Agent logs
              </h4>
              <p class="mt-1 text-xs text-on-surface-variant">
                Recent backend pipeline activity.
              </p>
              <p class="mt-1 text-[11px] text-on-surface-variant">
                {{ agentSourceCount }} subscribed source(s) currently eligible for pipeline runs.
              </p>
              <p v-if="rssReimportProgressText" class="mt-1 text-[11px] font-medium text-sky-200">
                {{ rssReimportProgressText }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                @click="loadAgentLogs"
                class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
              >
                Refresh logs
              </button>
              <button
                @click="clearAgentLogs"
                :disabled="isClearingLogs"
                class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isClearingLogs ? "Clearing..." : "Clear pipeline" }}
              </button>
            </div>
          </div>

          <div v-if="agentLogs.length === 0" class="mt-3 text-xs text-on-surface-variant">
            No agent logs yet.
          </div>

          <div v-else class="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
            <div
              v-for="log in agentLogs"
              :key="log.id"
              class="rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-bold text-on-surface">{{ log.status }}</span>
                    <span v-if="log.sourceId" class="text-[10px] text-on-surface-variant">source: {{ log.sourceId }}</span>
                  </div>
                  <p class="mt-1 text-xs text-on-surface-variant line-clamp-2">
                    {{ log.errorLog || "No details." }}
                  </p>
                </div>
                <div class="text-right text-[10px] text-on-surface-variant shrink-0">
                  <div>{{ formatLogTime(log.createdAt) }}</div>
                  <div>{{ log.executionTimeMs }}ms</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <PaywallModal
        v-model="showPaywallModal"
        @browser="openInBrowser"
        @read="openReaderFromModal"
      />

      <ArticleReaderModal
        v-model="showReaderModal"
        :article="activeArticleData"
        :content="readerContent"
        @browser="openInBrowser"
      />

      <RatingModal
        v-model="showRatingModal"
        :initialScore="activeRatingInitialScore"
        @confirm="handleConfirmRating"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useFeedStore } from "~/stores/feedStore";
import { $api } from "~/utils/api";

const { t } = useI18n();
const authStore = useAuthStore();
const feedStore = useFeedStore();

const isUserFreeTier = computed(() => {
  return !authStore.user?.tier || authStore.user.tier === "FREE";
});

const dateOptions = [
  { key: "today", isPro: false },
  { key: "last_24h", isPro: false },
  { key: "last_48h", isPro: true },
  { key: "last_1w", isPro: true },
] as const;

const visibleDateOptions = computed(() =>
  dateOptions.filter((option) => !option.isPro || !isUserFreeTier.value),
);

const defaultDateKey = computed(() =>
  visibleDateOptions.value.find((option) => option.key === "last_24h")?.key ||
  visibleDateOptions.value[0]?.key ||
  "last_24h",
);

const isAllowedDateKey = (key: string) =>
  dateOptions.some((option) => option.key === key && (!option.isPro || !isUserFreeTier.value));

definePageMeta({
  layout: "app-layout",
});

interface InterestNode {
  id: string;
  name: string;
  weight?: number;
  prompt?: string;
  chips?: any[];
}

interface Article {
  id: number;
  title: string;
  source: string;
  sourceUrl?: string;
  sourceTargetUrl?: string;
  canonicalUrl?: string;
  categoryPathUrl?: string | null;
  date: string;
  score: number;
  isPaywall: boolean;
  tags: string[];
  reasoning: string;
  signals: string[];
}

interface SourceFilterOption {
  id: string;
  type: "ROOT" | "CATEGORY";
  url: string;
  name: string;
}

const vClickOutside = {
  mounted(el: any, binding: any) {
    el.clickOutsideEvent = function (event: Event) {
      if (!(el === event.target || el.contains(event.target))) {
        binding.value(event, el);
      }
    };
    document.body.addEventListener("click", el.clickOutsideEvent);
  },
  unmounted(el: any) {
    document.body.removeEventListener("click", el.clickOutsideEvent);
  },
};

const articles = computed(() => feedStore.articles as Article[]);
const isLoading = computed(() => feedStore.isLoading);
const ARTICLES_PER_PAGE = 10;
const currentPage = ref(1);
const isPipelineRunning = ref(false);
const isEnrichingExistingArticles = ref(false);
const isHardCaseQueueRunning = ref(false);
const isFixingRssStatus = ref(false);
const isImportingRss = ref(false);
const isBackfillingArticleCategories = ref(false);
const isNormalizingHttpSources = ref(false);
const isAuditingHttpSourceMerge = ref(false);
const isDeletingSafeHttpDuplicates = ref(false);
const isAuditingScopedRss = ref(false);
const isNormalizingScopedSources = ref(false);
const isPruningScopedSources = ref(false);
const isDev = import.meta.env.DEV;
const canAccessDevPanel = ref(false);
const canRunManualPipeline = ref(false);
const canUseFullDevTools = ref(false);
const isClearingLogs = ref(false);
const agentLogs = ref<Array<{ id: string; status: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }>>([]);
const agentSourceCount = ref(0);
const createEmptyScopedSourceAuditSummary = () => ({
  generatedAt: "",
  totalSubPathSources: 0,
  keep: 0,
  normalizeToHttps: 0,
  candidateDeleteInvalidSubpath: 0,
  candidateSharedRootOnly: 0,
  needsManualReview: 0,
});
const scopedSourceAuditSummary = ref<{
  generatedAt: string;
  totalSubPathSources: number;
  keep: number;
  normalizeToHttps: number;
  candidateDeleteInvalidSubpath: number;
  candidateSharedRootOnly: number;
  needsManualReview: number;
}>(createEmptyScopedSourceAuditSummary());
const availableSources = ref<SourceFilterOption[]>([]);
const toast = ref({ show: false, message: "", type: "success" as "success" | "error" });

const toastClass = computed(() =>
  toast.value.type === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100",
);

const toastIcon = computed(() => (toast.value.type === "success" ? "check_circle" : "error"));
const showAdminPipelinePanel = computed(() => canAccessDevPanel.value && canRunManualPipeline.value);
const showFullDevTools = computed(() => isDev && showAdminPipelinePanel.value && canUseFullDevTools.value);
const isAdminUser = computed(() => authStore.user?.isAdmin === true || authStore.user?.role === "ADMIN");
let devPanelPollTimer: number | null = null;
const DEV_PANEL_POLL_MS = 10000;

const rssReimportProgressText = computed(() => {
  const currentLog = agentLogs.value.find((log) =>
    ["RSS_REIMPORT_STARTED", "RSS_REIMPORT_PROGRESS", "RSS_REIMPORT_FINISHED"].includes(log.status),
  );

  if (!currentLog) return "";

  if (currentLog.status === "RSS_REIMPORT_FINISHED") {
    return `Last reimport: ${currentLog.errorLog || "completed."}`;
  }

  if (currentLog.status === "RSS_REIMPORT_STARTED") {
    return currentLog.errorLog || "RSS reimport started.";
  }

  return currentLog.errorLog || "";
});

const startDevPanelPolling = () => {
  if (!import.meta.client || devPanelPollTimer || !showFullDevTools.value) return;
  devPanelPollTimer = window.setInterval(() => {
    void refreshDevPanel();
  }, DEV_PANEL_POLL_MS);
};

const stopDevPanelPolling = () => {
  if (!import.meta.client || !devPanelPollTimer) return;
  window.clearInterval(devPanelPollTimer);
  devPanelPollTimer = null;
};

onMounted(() => {
  void feedStore.fetchFeed();
  void loadAvailableSources();
  void initializeDevPanel();
});

watch(
  () => authStore.user?.id || null,
  (userId) => {
    if (!userId) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    if (!isAdminUser.value) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    void initializeDevPanel();
  },
);

watch(
  () => authStore.user?.isAdmin === true,
  (isAdmin) => {
    if (!isAdmin) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    void initializeDevPanel();
  },
);

const formatLogTime = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const checkDevPanelAccess = async () => {
  if (!isAdminUser.value) {
    canAccessDevPanel.value = false;
    canRunManualPipeline.value = false;
    canUseFullDevTools.value = false;
    stopDevPanelPolling();
    return false;
  }

  try {
    const response = await fetch("/api/dev/access", {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        canAccessDevPanel.value = false;
        canRunManualPipeline.value = false;
        canUseFullDevTools.value = false;
        stopDevPanelPolling();
        return false;
      }
      throw new Error(`Dev access check failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      ok: boolean;
      canAccess: boolean;
      manualPipelineEnabled?: boolean;
      devToolsEnabled?: boolean;
    };
    canAccessDevPanel.value = true;
    canRunManualPipeline.value = payload.manualPipelineEnabled !== false;
    canUseFullDevTools.value = payload.devToolsEnabled === true;
    return true;
  } catch (error: any) {
    if (
      error?.response?.status === 401 ||
      error?.response?.status === 403 ||
      error?.status === 401 ||
      error?.status === 403
    ) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return false;
    }
    return false;
  }
};

const initializeDevPanel = async () => {
  const hasAccess = await checkDevPanelAccess();
  if (!hasAccess) return;
  if (showFullDevTools.value) {
    await refreshDevPanel();
  }
};

const loadAgentLogs = async () => {
  if (!showFullDevTools.value) return;
  try {
    const response = await $api<{ ok: boolean; logs: Array<{ id: string; status: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }> }>("/api/dev/agent-logs");
    agentLogs.value = response.logs || [];
  } catch (error: any) {
    if (error?.response?.status === 429 || error?.status === 429) return;
    throw error;
  }
};

const loadEligibleSourceCount = async () => {
  if (!showFullDevTools.value) return;
  try {
    const response = await $api<{ ok: boolean; count: number }>("/api/dev/agent-source-count");
    agentSourceCount.value = response.count || 0;
  } catch (error: any) {
    if (error?.response?.status === 429 || error?.status === 429) return;
    throw error;
  }
};

const loadScopedSourceAuditSummary = async () => {
  if (!showFullDevTools.value) return;
  try {
    const response = await $api<{
      ok: boolean;
      report: null | {
        generatedAt: string;
        summary: {
          totalSubPathSources: number;
          keep: number;
          normalizeToHttps: number;
          candidateDeleteInvalidSubpath: number;
          candidateSharedRootOnly: number;
          needsManualReview: number;
        };
      };
    }>("/api/dev/scoped-source-audit");

    if (!response.report) {
      scopedSourceAuditSummary.value = createEmptyScopedSourceAuditSummary();
      return;
    }

    scopedSourceAuditSummary.value = {
      generatedAt: response.report.generatedAt,
      ...response.report.summary,
    };
  } catch (error: any) {
    if (error?.response?.status === 429 || error?.status === 429) return;
    throw error;
  }
};

const refreshDevPanel = async () => {
  if (!showFullDevTools.value) return;
  try {
    await Promise.all([loadAgentLogs(), loadEligibleSourceCount(), loadScopedSourceAuditSummary()]);
  } catch (error) {
    console.error("Failed to refresh dev panel:", error);
  }
};

const normalizeFilterUrl = (value?: string | null) =>
  (value || "").replace(/\/+$/, "").toLowerCase();

const matchesAppliedDateFilter = (article: Article) => {
  const articleDate = new Date(article.date);
  if (Number.isNaN(articleDate.getTime())) return false;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = now.getTime() - articleDate.getTime();

  switch (appliedSelectedDateKey.value) {
    case "today":
      return articleDate >= startOfToday;
    case "last_24h":
      return diffMs <= 24 * 60 * 60 * 1000;
    case "last_48h":
      return diffMs <= 48 * 60 * 60 * 1000;
    case "last_1w":
      return diffMs <= 7 * 24 * 60 * 60 * 1000;
    default:
      return true;
  }
};

const matchesAppliedCategoryFilter = (article: Article) => {
  if (appliedSelectedCategories.value.length === 0) return true;
  return article.tags.some((tag) => appliedSelectedCategories.value.includes(tag));
};

const matchesAppliedSourceFilter = (article: Article) => {
  if (appliedSelectedSources.value.length === 0) return true;

  const articleSourceUrl = normalizeFilterUrl(article.sourceUrl);
  const articleSourceTargetUrl = normalizeFilterUrl(article.sourceTargetUrl);
  const articleCategoryPathUrl = normalizeFilterUrl(article.categoryPathUrl);

  return appliedSelectedSources.value.some((selectedSourceId) => {
    const selectedSource = availableSources.value.find((source) => source.id === selectedSourceId);
    if (!selectedSource) return false;

    const selectedUrl = normalizeFilterUrl(selectedSource.url);
    return selectedSource.type === "CATEGORY"
      ? articleCategoryPathUrl === selectedUrl || articleSourceTargetUrl === selectedUrl
      : articleSourceUrl === selectedUrl && articleSourceTargetUrl === articleSourceUrl;
  });
};

const filteredArticles = computed(() =>
  articles.value.filter(
    (article) =>
      matchesAppliedDateFilter(article) &&
      matchesAppliedCategoryFilter(article) &&
      matchesAppliedSourceFilter(article),
  ),
);

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredArticles.value.length / ARTICLES_PER_PAGE)),
);

const paginatedArticles = computed(() => {
  const start = (currentPage.value - 1) * ARTICLES_PER_PAGE;
  return filteredArticles.value.slice(start, start + ARTICLES_PER_PAGE);
});

const visiblePageItems = computed(() => {
  const total = totalPages.value;
  const current = currentPage.value;

  if (total <= 5) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  if (current <= 2 || current >= total - 1) {
    return [1, 2, "ellipsis", total - 1, total];
  }

  return [1, 2, "ellipsis", current, "ellipsis", total - 1, total];
});

const setPage = (page: number) => {
  currentPage.value = Math.min(Math.max(page, 1), totalPages.value);
  activeActionMenu.value = null;
  activeOverlay.value = null;
  if (import.meta.client) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
};

const fixRssStatus = async () => {
  if (isFixingRssStatus.value) return;

  isFixingRssStatus.value = true;
  try {
    const response = await $api<{ ok: boolean; fixedCount: number }>("/api/dev/fix-rss-status", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Fixed ${response.fixedCount ?? 0} source RSS status record(s).`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Failed to fix RSS status records.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isFixingRssStatus.value = false;
  }
};

const reimportRss = async () => {
  if (isImportingRss.value) return;

  isImportingRss.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      success: boolean;
      message: string;
      created: number;
      updated: number;
      patched: number;
      verifiedActive: number;
      verifiedFailed: number;
      verifiedNoRss: number;
    }>("/api/dev/import-rss", {
      method: "GET",
    });
    toast.value = {
      show: true,
      message:
        response.message ||
        `RSS import completed. Created ${response.created}, patched ${response.patched}, active ${response.verifiedActive}.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "RSS import failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isImportingRss.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const backfillArticleCategories = async () => {
  if (isBackfillingArticleCategories.value) return;

  isBackfillingArticleCategories.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{ ok: boolean; scanned: number; updated: number; matchedSources: number }>(
      "/api/dev/backfill-article-categories",
      {
        method: "POST",
      },
    );
    toast.value = {
      show: true,
      message: `Backfill finished: ${response.updated ?? 0} article(s) updated from ${response.scanned ?? 0} scanned across ${response.matchedSources ?? 0} source(s).`,
      type: "success",
    };
    await feedStore.fetchFeed({ force: true });
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Article category backfill failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isBackfillingArticleCategories.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const normalizeHttpSources = async () => {
  if (isNormalizingHttpSources.value) return;

  isNormalizingHttpSources.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      updated: number;
      rssUpdated: number;
      conflicts: number;
      runtimeConflicts: number;
      invalidUrls: number;
    }>("/api/dev/http-source-normalization", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `HTTP source normalization finished: ${response.updated ?? 0} frontPageUrl and ${response.rssUpdated ?? 0} rssFeedUrl updated, ${response.conflicts ?? 0} total conflict(s) (${response.runtimeConflicts ?? 0} at runtime) and ${response.invalidUrls ?? 0} invalid URL(s) written to report.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "HTTP source normalization failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isNormalizingHttpSources.value = false;
  }
};

const auditHttpSourceMerge = async () => {
  if (isAuditingHttpSourceMerge.value) return;

  isAuditingHttpSourceMerge.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      summary: {
        totalConflictPairs: number;
        safeDeleteHttpSource: number;
        needsMergeBeforeDelete: number;
        manualReview: number;
      };
    }>("/api/dev/http-source-merge-audit", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `HTTP source merge audit ready: ${response.summary?.safeDeleteHttpSource ?? 0} safe delete, ${response.summary?.needsMergeBeforeDelete ?? 0} need merge, ${response.summary?.manualReview ?? 0} manual review.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "HTTP source merge audit failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isAuditingHttpSourceMerge.value = false;
  }
};

const deleteSafeHttpDuplicates = async () => {
  if (isDeletingSafeHttpDuplicates.value) return;

  isDeletingSafeHttpDuplicates.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      attempted: number;
      deleted: number;
    }>("/api/dev/http-source-safe-delete", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Safe HTTP duplicate cleanup finished: ${response.deleted ?? 0}/${response.attempted ?? 0} source(s) deleted.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Safe HTTP duplicate cleanup failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isDeletingSafeHttpDuplicates.value = false;
  }
};

const auditScopedRss = async () => {
  if (isAuditingScopedRss.value) return;

  isAuditingScopedRss.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      reportPath: string;
      summary: {
        totalSubPathSources: number;
        normalizeToHttps: number;
        candidateDeleteInvalidSubpath: number;
        candidateSharedRootOnly: number;
        needsManualReview: number;
      };
    }>("/api/dev/scoped-source-audit", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Scoped source report ready: normalize ${response.summary?.normalizeToHttps ?? 0}, delete candidates ${response.summary?.candidateDeleteInvalidSubpath ?? 0}, shared-root ${response.summary?.candidateSharedRootOnly ?? 0}.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Scoped source audit failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isAuditingScopedRss.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const normalizeScopedSources = async () => {
  if (isNormalizingScopedSources.value) return;

  isNormalizingScopedSources.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      attempted: number;
      updated: number;
      remaining: number;
    }>("/api/dev/scoped-source-normalize", {
      method: "POST",
      body: { limit: 25 },
    });
    toast.value = {
      show: true,
      message: `Scoped source normalization finished: ${response.updated ?? 0}/${response.attempted ?? 0} updated, ${response.remaining ?? 0} remaining in report.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Scoped source normalization failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isNormalizingScopedSources.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const pruneScopedSources = async () => {
  if (isPruningScopedSources.value) return;

  isPruningScopedSources.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      attempted: number;
      deleted: number;
      remaining: number;
    }>("/api/dev/scoped-source-prune", {
      method: "POST",
      body: { limit: 25 },
    });
    toast.value = {
      show: true,
      message: `Scoped source prune finished: ${response.deleted ?? 0}/${response.attempted ?? 0} deleted, ${response.remaining ?? 0} remaining in report.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Scoped source prune failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isPruningScopedSources.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const clearAgentLogs = async () => {
  if (!showFullDevTools.value || isClearingLogs.value) return;
  isClearingLogs.value = true;
  try {
    const response = await $api<{ ok: boolean; deletedCount: number; articleCount?: number; artifactCount?: number; runCount?: number }>("/api/dev/agent-logs", {
      method: "DELETE",
    });
    agentLogs.value = [];
    await feedStore.fetchFeed({ force: true });
    toast.value = {
      show: true,
      message: `Cleared ${response.articleCount ?? 0} article(s), ${response.deletedCount ?? 0} agent log(s), ${response.artifactCount ?? 0} artifact(s), and ${response.runCount ?? 0} pipeline run(s).`,
      type: "success",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Failed to clear logs.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isClearingLogs.value = false;
  }
};

const runManualPipeline = async () => {
  if (!showAdminPipelinePanel.value) return;
  if (isPipelineRunning.value) return;

  isPipelineRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{ ok: boolean; result?: any }>("/api/dev/run-news-pipeline", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Pipeline finished: ${response.result?.inserted ?? 0} inserted, ${response.result?.skipped ?? 0} skipped, ${response.result?.failed ?? 0} failed.`,
      type: "success",
    };
    await feedStore.fetchFeed({ force: true });
    window.setTimeout(() => {
      toast.value.show = false;
    }, 3500);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Pipeline run failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } finally {
    isPipelineRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const enrichExistingArticles = async () => {
  if (!showAdminPipelinePanel.value || isEnrichingExistingArticles.value) return;

  isEnrichingExistingArticles.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      scanned: number;
      updated: number;
      tagged: number;
      matchedCategories: number;
    }>("/api/dev/enrich-existing-articles", {
      method: "POST",
    });
    toast.value = {
      show: true,
      message: `Enrichment finished: ${response.updated ?? 0} category link(s) and ${response.tagged ?? 0} tag set(s) updated from ${response.scanned ?? 0} scanned article(s).`,
      type: "success",
    };
    await feedStore.fetchFeed({ force: true });
    if (showFullDevTools.value) {
      await refreshDevPanel();
    }
    window.setTimeout(() => {
      toast.value.show = false;
    }, 4500);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Article enrichment failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isEnrichingExistingArticles.value = false;
    if (showFullDevTools.value) {
      await refreshDevPanel();
    }
    stopDevPanelPolling();
  }
};

const runHardCaseQueue = async () => {
  if (!showFullDevTools.value) return;
  if (isHardCaseQueueRunning.value) return;

  isHardCaseQueueRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      result?: {
        processed: number;
        resolved: number;
        failedFinal: number;
        invalid: number;
      };
    }>("/api/dev/run-hard-case-discovery", {
      method: "POST",
      body: { limit: 10 },
    });
    toast.value = {
      show: true,
      message: `Hard-case queue finished: ${response.result?.resolved ?? 0} resolved, ${response.result?.failedFinal ?? 0} failed, ${response.result?.invalid ?? 0} invalid. Run the main pipeline after this to ingest from newly resolved feeds.`,
      type: "success",
    };
    await refreshDevPanel();
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } catch (error: any) {
    toast.value = {
      show: true,
      message: error?.statusMessage || error?.message || "Hard-case queue run failed.",
      type: "error",
    };
    window.setTimeout(() => {
      toast.value.show = false;
    }, 5000);
  } finally {
    isHardCaseQueueRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const loadAvailableSources = async () => {
  try {
    const response = await $api<{
      success: boolean;
      sources: Array<{
        id: string;
        type: "ROOT" | "CATEGORY";
        url: string;
        name: string;
        isActive: boolean;
      }>;
    }>("/api/user/sources");

    availableSources.value = (response.sources || [])
      .filter((source) => source.isActive)
      .map((source) => ({
        id: source.id,
        type: source.type,
        url: source.url,
        name: source.name,
      }));
  } catch (error) {
    console.error("Failed to load available sources:", error);
  }
};

const availableCategories = computed<{ key: string; value: string }[]>(() => {
  if (!authStore.user?.topInterests) return [];

  type CategoryOption = { key: string; value: string };

  const mappedCategories: CategoryOption[] = authStore.user.topInterests.map((interest: InterestNode) => ({
    key: interest.id,
    value: interest.name
  }));

  return mappedCategories.sort((a: CategoryOption, b: CategoryOption) => {
    const translatedA = t(`dashboard.filters.categories.${a.key}`);
    const translatedB = t(`dashboard.filters.categories.${b.key}`);
    
    return translatedA.localeCompare(translatedB);
  });
});

const isDateDropdownOpen = ref(false);
const isCategoryDropdownOpen = ref(false);
const isSourceDropdownOpen = ref(false);

const currentSelectedDateKey = ref("last_24h");
const selectedCategories = ref<string[]>([]);
const selectedSources = ref<string[]>([]);

const appliedSelectedDateKey = ref("last_24h");
const appliedSelectedCategories = ref<string[]>([]);
const appliedSelectedSources = ref<string[]>([]);
const isRefreshing = ref(false);

const localizedSelectedCategories = computed(() => {
  return selectedCategories.value
    .map((val) => {
      const matchedCategory = availableCategories.value.find(
        (c: { key: string; value: string }) => c.value === val,
      );
      return matchedCategory
        ? t(`dashboard.filters.categories.${matchedCategory.key}`)
        : val;
    })
    .join(", ");
});

const localizedSelectedSources = computed(() =>
  selectedSources.value
    .map((id) => availableSources.value.find((source) => source.id === id)?.name || id)
    .join(", "),
);

const hasPendingFilters = computed(() => {
  const dateChanged =
    currentSelectedDateKey.value !== appliedSelectedDateKey.value;
  const catChanged =
    JSON.stringify(selectedCategories.value) !==
    JSON.stringify(appliedSelectedCategories.value);
  const sourceChanged =
    JSON.stringify(selectedSources.value) !==
    JSON.stringify(appliedSelectedSources.value);
  return dateChanged || catChanged || sourceChanged;
});

const toggleDateDropdown = () => {
  isDateDropdownOpen.value = !isDateDropdownOpen.value;
  isCategoryDropdownOpen.value = false;
  isSourceDropdownOpen.value = false;
};

const toggleCategoryDropdown = () => {
  isCategoryDropdownOpen.value = !isCategoryDropdownOpen.value;
  isDateDropdownOpen.value = false;
  isSourceDropdownOpen.value = false;
};

const toggleSourceDropdown = () => {
  isSourceDropdownOpen.value = !isSourceDropdownOpen.value;
  isDateDropdownOpen.value = false;
  isCategoryDropdownOpen.value = false;
};

const selectDate = (key: string) => {
  currentSelectedDateKey.value = isAllowedDateKey(key) ? key : defaultDateKey.value;
  isDateDropdownOpen.value = false;
};

const selectCategory = (catValue: string) => {
  if (catValue === "All Categories") {
    selectedCategories.value = [];
  } else {
    const index = selectedCategories.value.indexOf(catValue);
    if (index === -1) {
      selectedCategories.value.push(catValue);
    } else {
      selectedCategories.value.splice(index, 1);
    }
  }
};

const selectSource = (sourceId: string) => {
  if (sourceId === "All Sources") {
    selectedSources.value = [];
  } else {
    const index = selectedSources.value.indexOf(sourceId);
    if (index === -1) {
      selectedSources.value.push(sourceId);
    } else {
      selectedSources.value.splice(index, 1);
    }
  }
};

const applyFilters = () => {
  if (!hasPendingFilters.value || isRefreshing.value) return;

  isRefreshing.value = true;
  setTimeout(() => {
    appliedSelectedDateKey.value = currentSelectedDateKey.value;
    appliedSelectedCategories.value = [...selectedCategories.value];
    appliedSelectedSources.value = [...selectedSources.value];
    currentPage.value = 1;
    closeArticleInteractions();
    isRefreshing.value = false;
  }, 600);
};

watch(
  [isUserFreeTier, visibleDateOptions],
  () => {
    if (!isAllowedDateKey(currentSelectedDateKey.value)) {
      currentSelectedDateKey.value = defaultDateKey.value;
    }
    if (!isAllowedDateKey(appliedSelectedDateKey.value)) {
      appliedSelectedDateKey.value = defaultDateKey.value;
    }
  },
  { immediate: true },
);

const activeActionMenu = ref<number | null>(null);
const activeOverlay = ref<number | null>(null);

const closeArticleInteractions = () => {
  activeActionMenu.value = null;
  activeOverlay.value = null;
};

const toggleActionMenu = (id: number) => {
  if (activeOverlay.value === id) {
    activeOverlay.value = null;
    activeActionMenu.value = id;
  } else {
    activeOverlay.value = null;
    activeActionMenu.value = activeActionMenu.value === id ? null : id;
  }
};

watch(
  () => filteredArticles.value.length,
  () => {
    if (currentPage.value > totalPages.value) {
      currentPage.value = totalPages.value;
    }
  },
);

const openOverlay = (id: number) => {
  activeActionMenu.value = null;
  activeOverlay.value = id;
};

const showPaywallModal = ref(false);
const showReaderModal = ref(false);
const activeArticleData = ref<any>(null);
const showRatingModal = ref(false);
const activeRatingArticleId = ref<number | null>(null);

const loremIpsum = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.",
  "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.",
  "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione.",
];

const readerContent = computed(() => {
  if (!activeArticleData.value) return "";
  if (activeArticleData.value.isPaywall) {
    return `<p>${loremIpsum[0]}</p><p>${loremIpsum[1]}</p><p class="opacity-30 pb-40">${loremIpsum[2]}</p>`;
  }
  return loremIpsum.map((p) => `<p>${p}</p>`).join("");
});

const handleReadNow = (article: any) => {
  activeArticleData.value = article;
  if (article.isPaywall) {
    showPaywallModal.value = true;
  } else {
    showReaderModal.value = true;
    document.body.style.overflow = "hidden";
  }
};

const openReaderFromModal = () => {
  showPaywallModal.value = false;
  setTimeout(() => {
    showReaderModal.value = true;
    document.body.style.overflow = "hidden";
  }, 300);
};

const openInBrowser = () => {
  const targetUrl =
    activeArticleData.value?.canonicalUrl || activeArticleData.value?.sourceUrl;
  if (import.meta.client && targetUrl) {
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  }
  showPaywallModal.value = false;
};

const activeRatingInitialScore = computed(() => {
  if (!activeRatingArticleId.value) return 0;
  const article = articles.value.find(
    (a) => a.id === activeRatingArticleId.value,
  );
  return article ? article.score : 0;
});

const openRatingModal = (id: number) => {
  activeRatingArticleId.value = id;
  showRatingModal.value = true;
  activeActionMenu.value = null;
};

const handleConfirmRating = (newScore: number) => {
  const articleIndex = articles.value.findIndex(
    (a) => a.id === activeRatingArticleId.value,
  );
  if (articleIndex !== -1) {
    const targetArticle = articles.value[articleIndex];
    if (targetArticle) {
      targetArticle.score = newScore;
    }
  }
};

watch(
  [showPaywallModal, showReaderModal, showRatingModal],
  ([newPaywall, newReader, newRating]) => {
    if (newPaywall || newReader || newRating) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
  },
);
</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
