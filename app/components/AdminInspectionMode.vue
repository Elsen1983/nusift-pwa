<template>
  <div v-if="accessState === 'allowed'">
    <button
      v-if="!inspectionMode"
      type="button"
      class="fixed bottom-5 right-5 z-[110] inline-flex items-center gap-2 rounded-full border border-violet-300/35 bg-surface-container-high px-4 py-2.5 text-xs font-bold text-violet-100 shadow-xl shadow-black/30 transition hover:border-violet-200/60 hover:bg-violet-300/15"
      @click="toggleMode"
    >
      <span class="material-symbols-outlined text-[18px] text-violet-200">admin_panel_settings</span>
      Admin Inspection
    </button>
    <section
      v-else
      class="relative z-[100] mx-auto w-full max-w-5xl rounded-2xl border border-violet-400/25 bg-violet-500/5 px-4 py-3 shadow-lg shadow-violet-950/10"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="material-symbols-outlined text-violet-200"
              >admin_panel_settings</span
            >
            <h2 class="font-headline text-sm font-bold text-on-surface">
              Operational inspection
            </h2>
            <span
              class="rounded-full bg-violet-400/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-200"
              >Admin only</span
            >
          </div>
          <p class="mt-1 text-[11px] text-on-surface-variant">
            Inspect all active system targets without changing subscriptions,
            quota, feed scope, or notifications.
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-violet-300/25 bg-violet-300/10 px-3 py-1.5 text-xs font-bold text-violet-100 transition hover:bg-violet-300/20"
          @click="toggleMode"
        >
          My Sources
        </button>
      </div>
      <div v-if="inspectionMode" class="mt-4 space-y-4">
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Search<input
              v-model="search"
              type="search"
              maxlength="120"
              placeholder="Source or category"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface outline-none focus:border-violet-300/50"
              @input="refreshSourcesDebounced"
          /></label>
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Target type<select
              v-model="targetType"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface"
              @change="changeTargetType"
            >
              <option value="ALL">All targets</option>
              <option value="SOURCE">Sources</option>
              <option value="CATEGORY">Categories</option>
            </select></label
          >
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Window<select
              v-model="windowKey"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface"
              @change="changeWindow"
            >
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select></label
          >
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Custom from<input
              v-model="dateFrom"
              type="date"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs text-on-surface"
              @change="applyCustomRange"
          /></label>
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Custom to<input
              v-model="dateTo"
              type="date"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs text-on-surface"
              @change="applyCustomRange"
          /></label>
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Article state<select
              v-model="articleState"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface"
              @change="resetAndRefreshArticles"
            >
              <option value="ALL">All states</option>
              <option v-for="state in states" :key="state" :value="state">
                {{ state.replaceAll("_", " ") }}
              </option>
            </select></label
          >
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Pipeline stage<select
              v-model="pipelineStage"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface"
              @change="resetAndRefreshArticles"
            >
              <option value="ALL">All stages</option>
              <option v-for="stage in stages" :key="stage" :value="stage">
                {{ stage }}
              </option>
            </select></label
          >
          <label
            class="min-w-0 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Productivity<select
              v-model="productivityState"
              class="mt-1 w-full rounded-lg border border-outline-variant/25 bg-surface-container px-2.5 py-2 text-xs font-normal normal-case text-on-surface"
              @change="() => refreshSources()"
            >
              <option value="ALL">All productivity</option>
              <option value="NO_ARTICLES_GENERATED">
                No articles generated
              </option>
              <option value="DISCOVERED_NOT_ENRICHED">
                Discovered, not enriched
              </option>
              <option value="RETRY_BACKLOG">Retry backlog</option>
              <option value="BROWSER_FALLBACK_REQUIRED">
                Browser fallback required
              </option>
            </select></label
          >
          <label
            class="flex items-end gap-2 rounded-lg border border-amber-300/20 bg-amber-400/5 px-2.5 py-2 text-[10px] font-bold text-amber-100"
            ><input
              v-model="allActive"
              type="checkbox"
              class="accent-violet-400"
              @change="toggleAllActive"
            /><span
              >All active targets<br /><small
                class="font-normal text-amber-100/70"
                >Explicit, bounded mode</small
              ></span
            ></label
          >
        </div>
        <p
          v-if="rangeError"
          class="rounded-lg border border-rose-300/20 bg-rose-400/5 px-3 py-2 text-[10px] text-rose-100"
        >
          {{ rangeError }}
        </p>
        <div
          v-if="selectedTargets.length"
          class="flex flex-wrap items-center gap-1.5"
        >
          <span
            class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            >Selected ({{ selectedTargets.length }}/25)</span
          ><button
            v-for="target in selectedTargets"
            :key="`${target.targetType}:${target.targetId}`"
            type="button"
            class="inline-flex max-w-full items-center gap-1 rounded-full border border-violet-300/20 bg-violet-300/10 px-2 py-1 text-[10px] text-violet-100"
            @click="removeTarget(target.targetId, target.targetType)"
          >
            <span class="max-w-[180px] truncate">{{ target.displayName }}</span
            ><span aria-hidden="true">×</span></button
          ><button
            type="button"
            class="text-[10px] font-bold text-rose-200"
            @click="clearTargets"
          >
            Clear all
          </button>
        </div>
        <div
          v-if="sourceSummary"
          class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8"
        >
          <div
            v-for="card in sourceSummary"
            :key="card.label"
            class="rounded-lg border border-outline-variant/15 bg-surface-container/70 p-2"
          >
            <div class="text-lg font-bold text-on-surface">
              {{ card.value }}
            </div>
            <div class="text-[9px] leading-tight text-on-surface-variant">
              {{ card.label
              }}<span
                v-if="serverSummary?.metricAccuracy === 'APPROXIMATE'"
                class="ml-1 text-amber-200"
                title="Some values use bounded evidence"
                >≈</span
              >
            </div>
          </div>
        </div>
        <p
          v-if="
            sourceTruncated ||
            articleTruncated ||
            serverSummary?.metricAccuracy === 'APPROXIMATE'
          "
          class="rounded-lg border border-amber-300/20 bg-amber-400/5 px-3 py-2 text-[10px] text-amber-100"
        >
          Some diagnostics are bounded or approximate. Continue loading for
          later results.
        </p>
        <div
          class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
        >
          <div
            class="min-w-0 rounded-xl border border-outline-variant/15 bg-surface-container/50 p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-xs font-bold text-on-surface">System targets</h3>
              <button
                type="button"
                class="text-[10px] font-bold text-violet-200"
                @click="() => refreshSources()"
              >
                Refresh
              </button>
            </div>
            <p v-if="sourceError" class="mt-2 text-xs text-rose-200">
              {{ sourceError }}
            </p>
            <p
              v-else-if="sourceLoading"
              class="mt-2 text-xs text-on-surface-variant"
            >
              Loading targets…
            </p>
            <p
              v-else-if="sources.length === 0"
              class="mt-2 text-xs text-on-surface-variant"
            >
              No targets match this search.
            </p>
            <div v-else class="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
              <button
                v-for="target in sources"
                :key="`${target.targetType}:${target.targetId}`"
                type="button"
                class="w-full min-w-0 rounded-lg border border-outline-variant/15 bg-surface-container px-2.5 py-2 text-left transition hover:border-violet-300/35"
                :class="
                  selectedIds.has(`${target.targetType}:${target.targetId}`)
                    ? 'border-violet-300/40 bg-violet-400/10'
                    : ''
                "
                @click="toggleTarget(target)"
              >
                <div class="flex min-w-0 items-start justify-between gap-2">
                  <span
                    class="min-w-0 truncate text-xs font-bold text-on-surface"
                    >{{ target.displayName }}</span
                  ><span
                    class="shrink-0 text-[9px] uppercase text-on-surface-variant"
                    >{{ target.targetType }}</span
                  >
                </div>
                <div
                  class="mt-1 flex flex-wrap gap-x-2 text-[9px] text-on-surface-variant"
                >
                  <span>{{ target.totalArticlesInWindow }} articles</span
                  ><span>{{ target.publishedArticlesInWindow }} published</span
                  ><span>{{ target.activityState }}</span>
                </div>
                <p
                  v-if="target.pathUrl || target.frontPageUrl"
                  class="mt-1 truncate text-[9px] text-violet-200/70"
                >
                  {{ target.pathUrl || target.frontPageUrl }}
                </p>
                <div class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="flag in target.diagnosticFlags.slice(0, 3)"
                    :key="flag"
                    class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[8px] text-amber-100"
                    >{{ flag.replaceAll("_", " ") }}</span
                  >
                </div>
              </button>
            </div>
            <div class="mt-2 flex justify-between">
              <button
                type="button"
                class="text-[10px] font-bold text-violet-200 disabled:opacity-40"
                :disabled="!sourceCursor || sourceLoading"
                @click="() => loadNextSources()"
              >
                Load more
              </button>
            </div>
          </div>
          <div
            class="min-w-0 rounded-xl border border-outline-variant/15 bg-surface-container/50 p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-xs font-bold text-on-surface">
                Inspected articles
              </h3>
              <button
                type="button"
                class="text-[10px] font-bold text-violet-200"
                @click="() => refreshArticles()"
              >
                Refresh
              </button>
            </div>
            <div
              v-if="selectedTargets.length > 0"
              class="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1"
            >
              <article
                v-for="target in selectedTargets"
                :key="`diagnostic:${target.targetType}:${target.targetId}`"
                class="rounded-lg border border-violet-300/15 bg-violet-400/5 p-2.5"
              >
                <div class="flex min-w-0 items-start justify-between gap-2">
                  <h4 class="min-w-0 truncate text-xs font-bold text-on-surface">
                    {{ target.displayName }}
                  </h4>
                  <span class="shrink-0 text-[9px] uppercase text-violet-200">
                    {{ target.targetType }}
                  </span>
                </div>
                <p
                  v-if="target.pathUrl || target.frontPageUrl"
                  class="mt-1 break-all text-[9px] text-violet-200/75"
                >
                  {{ target.pathUrl || target.frontPageUrl }}
                </p>
                <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-on-surface-variant">
                  <span>activity: <strong>{{ target.activityState }}</strong></span>
                  <span>lifecycle: <strong>{{ target.lifecycleState }}</strong></span>
                  <span>active reason: <strong>{{ target.activeReason }}</strong></span>
                  <span>RSS: <strong>{{ target.rssStatus }}</strong></span>
                  <span>articles: <strong>{{ target.totalArticlesInWindow }}</strong></span>
                  <span>published: <strong>{{ target.publishedArticlesInWindow }}</strong></span>
                  <span>deferred: <strong>{{ target.deferredArticlesInWindow }}</strong></span>
                  <span>retryable: <strong>{{ target.retryableFailuresInWindow }}</strong></span>
                </div>
                <p v-if="target.rssFeedUrl" class="mt-1 break-all text-[9px] text-on-surface-variant/70">
                  RSS: {{ target.rssFeedUrl }}
                </p>
                <div v-if="target.diagnosticFlags?.length" class="mt-1.5 flex flex-wrap gap-1">
                  <span
                    v-for="flag in target.diagnosticFlags"
                    :key="flag"
                    class="rounded bg-amber-300/10 px-1.5 py-0.5 text-[8px] text-amber-100"
                  >{{ flag.replaceAll("_", " ") }}</span>
                </div>
              </article>
            </div>
            <p v-if="articleError" class="mt-2 text-xs text-rose-200">
              {{ articleError }}
            </p>
            <p
              v-else-if="articleLoading"
              class="mt-2 text-xs text-on-surface-variant"
            >
              Loading articles…
            </p>
            <p
              v-else-if="!allActive && selectedTargets.length === 0"
              class="mt-2 text-xs text-on-surface-variant"
            >
              Select at least one target, or explicitly enable all active
              sources.
            </p>
            <p
              v-else-if="articles.length === 0"
              class="mt-2 text-xs text-on-surface-variant"
            >
              No articles match the selected filters.
            </p>
            <div
              v-else
              class="mt-2 max-h-[31rem] space-y-2 overflow-y-auto pr-1"
            >
              <button
                v-for="item in articles"
                :key="item.articleId"
                type="button"
                class="block w-full rounded-xl border border-outline-variant/15 bg-surface-container px-3 py-2.5 text-left"
                @click="openDetail(item.articleId)"
              >
                <div class="flex min-w-0 items-start justify-between gap-2">
                  <h4
                    class="min-w-0 truncate text-xs font-bold text-on-surface"
                  >
                    {{ item.title || "Untitled article" }}
                  </h4>
                  <span
                    class="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase"
                    :class="stateClass(item.durableState || 'PENDING')"
                    >{{ item.durableState.replaceAll("_", " ") }}</span
                  >
                </div>
                <div
                  class="mt-1 flex flex-wrap gap-x-2 text-[9px] text-on-surface-variant"
                >
                  <span>{{ item.pipelineStage }}</span
                  ><span>{{ item.source.label }}</span
                  ><span v-if="item.category">· {{ item.category.label }}</span>
                </div>
                <p
                  v-if="item.evidenceSummary"
                  class="mt-1 line-clamp-2 text-[10px] text-amber-100/80"
                >
                  {{ item.evidenceSummary }}
                </p>
                <p
                  v-if="item.bodyPreview"
                  class="mt-1 line-clamp-2 text-[10px] text-on-surface-variant"
                >
                  {{ item.bodyPreview }}
                </p>
              </button>
            </div>
            <div class="mt-2 flex justify-between">
              <button
                type="button"
                class="text-[10px] font-bold text-violet-200 disabled:opacity-40"
                :disabled="!articleCursor || articleLoading"
                @click="() => loadNextArticles()"
              >
                Load more
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <div
      v-if="detailLoading || detail || detailError"
      class="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-3 sm:items-center"
    >
      <div
        class="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface-container p-4"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-on-surface">
            Article inspection detail
          </h3>
          <button
            type="button"
            class="text-lg text-on-surface-variant"
            @click="closeDetail"
          >
            ×
          </button>
        </div>
        <p v-if="detailLoading" class="mt-3 text-xs text-on-surface-variant">
          Loading detail…
        </p>
        <div
          v-else-if="detailError"
          class="mt-3 rounded-lg border border-rose-300/20 bg-rose-400/5 p-3 text-xs text-rose-100"
        >
          <p>{{ detailError }}</p>
          <button
            type="button"
            class="mt-2 rounded border border-rose-200/30 px-2 py-1 font-bold"
            @click="retryDetail"
          >
            Retry
          </button>
        </div>
        <div
          v-else-if="detail"
          class="mt-3 space-y-2 text-xs text-on-surface-variant"
        >
          <p>
            <strong class="text-on-surface">{{ detail.item.title }}</strong>
          </p>
          <p>
            {{ detail.item.durableState }} · {{ detail.item.pipelineStage }}
          </p>
          <p v-if="detail.item.bodyPreview">{{ detail.item.bodyPreview }}</p>
          <p v-if="detail.item.evidenceSummary">
            {{ detail.item.evidenceSummary }}
          </p>
          <div
            v-for="event in detail.item.evidenceTimeline"
            :key="`${event.createdAt}:${event.type}`"
            class="rounded border border-outline-variant/15 p-2"
          >
            <span class="text-on-surface">{{ event.type }}</span> ·
            {{ event.status }} · {{ event.summary }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { $api } from "~/utils/api";
import { useAuthStore } from "~/stores/auth";

type Target = {
  targetId: string;
  targetType: "SOURCE" | "CATEGORY";
  displayName: string;
  [key: string]: any;
};
type Article = {
  articleId: number;
  durableState: string;
  pipelineStage: string;
  title: string | null;
  source: { label: string | null };
  category: { label: string | null } | null;
  discoveredAt: string;
  evidenceSummary: string | null;
  bodyPreview: string | null;
};
const authStore = useAuthStore();
const accessState = ref<"unknown" | "allowed" | "denied">("unknown");
const inspectionMode = useState<boolean>("adminInspectionMode", () => false);
const sources = ref<Target[]>([]);
const articles = ref<Article[]>([]);
const selectedTargets = ref<Target[]>([]);
const detail = ref<any>(null);
const detailError = ref<string | null>(null);
const detailArticleId = ref<number | null>(null);
const search = ref("");
const windowKey = ref("7d");
const dateFrom = ref("");
const dateTo = ref("");
const sourceEffectiveRange = ref<{ dateFrom: string; dateTo: string } | null>(
  null,
);
const articleEffectiveRange = ref<{ dateFrom: string; dateTo: string } | null>(
  null,
);
const rangeError = ref<string | null>(null);
const targetType = ref("ALL");
const articleState = ref("ALL");
const pipelineStage = ref("ALL");
const productivityState = ref("ALL");
const allActive = ref(false);
const sourceLoading = ref(false);
const articleLoading = ref(false);
const detailLoading = ref(false);
const sourceError = ref<string | null>(null);
const articleError = ref<string | null>(null);
const sourceCursor = ref<string | null>(null);
const articleCursor = ref<string | null>(null);
const sourceTruncated = ref(false);
const articleTruncated = ref(false);
const sourceSnapshotToken = ref<string | null>(null);
const sourceSnapshotTargetType = ref<string>("ALL");
const states = [
  "PUBLISHED",
  "PENDING",
  "DEFERRED",
  "RETRYABLE_FAILURE",
  "PERMANENT_FAILURE",
  "REJECTED",
];
const stages = ["AGENT1", "AGENT2", "AGENT3", "TERMINAL", "UNKNOWN"];
let sourceRequestSequence = 0;
let articleRequestSequence = 0;
let detailRequestSequence = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const selectedIds = computed(
  () =>
    new Set(
      selectedTargets.value.map(
        (target) => `${target.targetType}:${target.targetId}`,
      ),
    ),
);
const rangeParams = (kind: "source" | "article") => {
  const effective =
    kind === "source"
      ? sourceEffectiveRange.value
      : articleEffectiveRange.value;
  if (effective) return effective;
  if (windowKey.value === "custom")
    return {
      dateFrom: `${dateFrom.value}T00:00:00.000Z`,
      dateTo: `${dateTo.value}T23:59:59.999Z`,
    };
  const end = new Date();
  const start = new Date(
    end.getTime() -
      (windowKey.value === "24h"
        ? 86400000
        : windowKey.value === "30d"
          ? 30 * 86400000
          : 7 * 86400000),
  );
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
};
const validateCustomRange = () => {
  rangeError.value = null;
  if (!dateFrom.value || !dateTo.value) {
    rangeError.value = "Choose both custom dates.";
    return false;
  }
  const from = new Date(`${dateFrom.value}T00:00:00.000Z`);
  const to = new Date(`${dateTo.value}T23:59:59.999Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    rangeError.value = "Enter valid custom dates.";
    return false;
  }
  if (from > to) {
    rangeError.value = "The start date must not be after the end date.";
    return false;
  }
  if (to > new Date()) {
    rangeError.value = "The custom end date cannot be in the future.";
    return false;
  }
  if (to.getTime() - from.getTime() > 90 * 86400000) {
    rangeError.value = "The custom range cannot exceed 90 days.";
    return false;
  }
  return true;
};
const applyCustomRange = () => {
  windowKey.value = "custom";
  if (validateCustomRange()) refreshAll();
};
const changeWindow = () => {
  sourceEffectiveRange.value = null;
  articleEffectiveRange.value = null;
  if (windowKey.value === "custom") {
    if (dateFrom.value && dateTo.value) {
      if (validateCustomRange()) refreshAll();
    } else {
      rangeError.value = "Choose both custom dates.";
    }
    return;
  }
  rangeError.value = null;
  refreshAll();
};
const changeTargetType = () => {
  if (targetType.value !== "ALL")
    selectedTargets.value = selectedTargets.value.filter(
      (target) => target.targetType === targetType.value,
    );
  sourceCursor.value = null;
  articleCursor.value = null;
  sourceSnapshotToken.value = null;
  refreshAll();
};
const refreshSources = async (append = false) => {
  if (accessState.value !== "allowed") return;
  const seq = ++sourceRequestSequence;
  sourceLoading.value = true;
  sourceError.value = null;
  try {
    const params = new URLSearchParams({
      limit: "50",
      targetType: targetType.value,
      productivityState: productivityState.value,
      ...rangeParams("source"),
    });
    if (search.value.trim()) params.set("search", search.value.trim());
    if (append && sourceCursor.value) params.set("cursor", sourceCursor.value);
    const response = await $api<{
      items: Target[];
      summary?: any;
      snapshot?: any;
      snapshotToken?: string | null;
      pagination?: {
        nextCursor?: string | null;
        scanTruncated?: boolean;
        dateFrom?: string;
        dateTo?: string;
      };
    }>(`/api/dev/admin-source-inspection?${params}`);
    if (seq === sourceRequestSequence) {
      const incoming = response.items || [];
      const existing = new Set(
        sources.value.map((item) => `${item.targetType}:${item.targetId}`),
      );
      const unique = incoming.filter(
        (item) => !existing.has(`${item.targetType}:${item.targetId}`),
      );
      sources.value = append ? [...sources.value, ...unique] : incoming;
      serverSummary.value = response.summary || null;
      if (response.pagination?.dateFrom && response.pagination?.dateTo)
        sourceEffectiveRange.value = {
          dateFrom: response.pagination.dateFrom,
          dateTo: response.pagination.dateTo,
        };
      sourceCursor.value = response.pagination?.nextCursor || null;
      sourceTruncated.value = response.pagination?.scanTruncated === true;
      if (!append && response.snapshot?.available && response.snapshotToken) {
        sourceSnapshotToken.value = response.snapshotToken;
        sourceSnapshotTargetType.value = response.snapshot.targetType;
      }
    }
  } catch (error: any) {
    if (seq === sourceRequestSequence)
      sourceError.value =
        error?.data?.statusMessage ||
        error?.message ||
        "Inspection targets unavailable.";
  } finally {
    if (seq === sourceRequestSequence) sourceLoading.value = false;
  }
};
const refreshArticles = async (append = false) => {
  if (
    accessState.value !== "allowed" ||
    (!allActive.value && selectedTargets.value.length === 0)
  ) {
    articles.value = [];
    articleCursor.value = null;
    return;
  }
  const seq = ++articleRequestSequence;
  articleLoading.value = true;
  articleError.value = null;
  try {
    const commonParams = {
      limit: "50",
      articleState: articleState.value,
      pipelineStage: pipelineStage.value,
      targetType: targetType.value,
      ...rangeParams("article"),
    };
    const response = await (allActive.value
      ? (async () => {
          const payload: Record<string, unknown> = {
            ...commonParams,
            allActive: true,
          };
          if (articleCursor.value && append)
            payload.cursor = articleCursor.value;
          // Reuse the exact validated active-target snapshot from source
          // inspection when it matches the requested target-type boundary;
          // otherwise the endpoint resolves (and reports) an independent
          // snapshot. The token travels in the bounded POST body, never in a
          // GET URL, so proxies and request-line limits cannot reject it.
          if (
            sourceSnapshotToken.value &&
            sourceSnapshotTargetType.value === targetType.value
          )
            payload.snapshot = sourceSnapshotToken.value;
          return $api<{
            items: Article[];
            selection?: { snapshotSource?: string };
            pagination?: {
              nextCursor?: string | null;
              scanTruncated?: boolean;
              dateFrom?: string;
              dateTo?: string;
            };
          }>("/api/dev/admin-article-inspection", {
            method: "POST",
            body: payload,
          });
        })()
      : (async () => {
          const params = new URLSearchParams(commonParams);
          params.set(
            "targetIds",
            selectedTargets.value.map((target) => target.targetId).join(","),
          );
          const types = new Set(
            selectedTargets.value.map((target) => target.targetType),
          );
          if (types.size === 1) {
            const onlyType = [...types][0];
            if (onlyType) params.set("targetType", onlyType);
          }
          if (articleCursor.value && append)
            params.set("cursor", articleCursor.value);
          return $api<{
            items: Article[];
            selection?: { snapshotSource?: string };
            pagination?: {
              nextCursor?: string | null;
              scanTruncated?: boolean;
              dateFrom?: string;
              dateTo?: string;
            };
          }>(`/api/dev/admin-article-inspection?${params}`);
        })());
    if (seq === articleRequestSequence) {
      if (response.pagination?.dateFrom && response.pagination?.dateTo)
        articleEffectiveRange.value = {
          dateFrom: response.pagination.dateFrom,
          dateTo: response.pagination.dateTo,
        };
      const incoming = response.items || [];
      const existing = new Set(articles.value.map((item) => item.articleId));
      const unique = incoming.filter((item) => !existing.has(item.articleId));
      articles.value = append ? [...articles.value, ...unique] : incoming;
      articleCursor.value = response.pagination?.nextCursor || null;
      articleTruncated.value = response.pagination?.scanTruncated === true;
    }
  } catch (error: any) {
    if (seq === articleRequestSequence)
      articleError.value =
        error?.data?.statusMessage ||
        error?.message ||
        "Inspected articles unavailable.";
  } finally {
    if (seq === articleRequestSequence) articleLoading.value = false;
  }
};
const refreshAll = () => {
  if (windowKey.value === "custom" && !validateCustomRange()) return;
  sourceEffectiveRange.value = null;
  articleEffectiveRange.value = null;
  sourceRequestSequence++;
  articleRequestSequence++;
  sourceCursor.value = null;
  articleCursor.value = null;
  sources.value = [];
  articles.value = [];
  serverSummary.value = null;
  void refreshSources();
  void refreshArticles();
};
const resetAndRefreshArticles = () => {
  articleCursor.value = null;
  void refreshArticles();
};
const loadNextSources = () => {
  if (sourceCursor.value) void refreshSources(true);
};
const loadNextArticles = () => {
  if (articleCursor.value) void refreshArticles(true);
};
const refreshSourcesDebounced = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    sourceCursor.value = null;
    void refreshSources();
  }, 250);
};
const toggleTarget = (target: Target) => {
  if (allActive.value) allActive.value = false;
  const index = selectedTargets.value.findIndex(
    (item) =>
      item.targetType === target.targetType &&
      item.targetId === target.targetId,
  );
  if (index >= 0) selectedTargets.value.splice(index, 1);
  else if (selectedTargets.value.length < 25)
    selectedTargets.value.push(target);
  articleCursor.value = null;
  void refreshArticles();
};
const removeTarget = (id: string, type?: Target["targetType"]) => {
  selectedTargets.value = selectedTargets.value.filter(
    (target) =>
      !(target.targetId === id && (!type || target.targetType === type)),
  );
  articleCursor.value = null;
  void refreshArticles();
};
const clearTargets = () => {
  selectedTargets.value = [];
  articles.value = [];
  articleCursor.value = null;
};
const toggleAllActive = () => {
  if (
    allActive.value &&
    !window.confirm("Inspect all active sources in a bounded view?")
  ) {
    allActive.value = false;
    return;
  }
  if (allActive.value) selectedTargets.value = [];
  articleCursor.value = null;
  void refreshArticles();
};
const toggleMode = () => {
  inspectionMode.value = !inspectionMode.value;
  if (inspectionMode.value) refreshAll();
};
const openDetail = async (articleId: number) => {
  const seq = ++detailRequestSequence;
  detailArticleId.value = articleId;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  try {
    const response = await $api(
      `/api/dev/admin-article-inspection/${articleId}`,
    );
    if (seq === detailRequestSequence) detail.value = response;
  } catch (error: any) {
    if (seq === detailRequestSequence)
      detailError.value =
        error?.statusCode === 404
          ? "Article not found."
          : error?.statusCode === 403
            ? "Inspection access is no longer available."
            : error?.statusCode === 429
              ? "Too many requests. Try again shortly."
              : "Article detail is unavailable.";
  } finally {
    if (seq === detailRequestSequence) detailLoading.value = false;
  }
};
const retryDetail = () => {
  if (detailArticleId.value !== null) void openDetail(detailArticleId.value);
};
const closeDetail = () => {
  detailRequestSequence++;
  detailLoading.value = false;
  detail.value = null;
  detailError.value = null;
  detailArticleId.value = null;
};
const stateClass = (state: string) =>
  state === "PUBLISHED"
    ? "bg-emerald-400/15 text-emerald-200"
    : state === "REJECTED" || state === "PERMANENT_FAILURE"
      ? "bg-rose-400/15 text-rose-200"
      : "bg-amber-400/15 text-amber-100";
const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString();
};
const serverSummary = ref<any>(null);
const sourceSummary = computed(() => {
  const summary = serverSummary.value;
  if (summary)
    return [
      { label: "targets", value: summary.loadedTargets },
      { label: "productive", value: summary.productiveTargets },
      { label: "zero articles", value: summary.zeroArticleTargets },
      { label: "not enriched", value: summary.discoveredNotEnrichedTargets },
      { label: "deferred", value: summary.deferredTargets },
      { label: "permanent failures", value: summary.permanentFailures },
      { label: "browser required", value: summary.browserRequiredTargets },
      { label: "published", value: summary.publishedArticles },
    ];
  const rows = sources.value;
  return [
    { label: "targets", value: rows.length },
    {
      label: "productive",
      value: rows.filter((r) => r.activityState === "ACTIVE_AND_PRODUCTIVE")
        .length,
    },
  ];
});
let accessRequestSequence = 0;
const loadInspectionAccess = async (hasClientUser: boolean) => {
  const seq = ++accessRequestSequence;
  if (!hasClientUser) {
    accessState.value = "unknown";
    return;
  }
  accessState.value = "unknown";
  try {
    await $api("/api/dev/admin-inspection-access");
    if (seq === accessRequestSequence) accessState.value = "allowed";
  } catch {
    if (seq === accessRequestSequence) accessState.value = "denied";
  }
};
const lastUserId = ref<string | null>(null);
watch(
  () => authStore.user?.id ?? null,
  (userId) => {
    if (lastUserId.value !== null && lastUserId.value !== userId) {
      inspectionMode.value = false;
      selectedTargets.value = [];
      sources.value = [];
      articles.value = [];
      detail.value = null;
      detailError.value = null;
      detailArticleId.value = null;
      sourceCursor.value = null;
      articleCursor.value = null;
      sourceRequestSequence++;
      articleRequestSequence++;
      detailRequestSequence++;
    }
    lastUserId.value = userId;
    if (!userId) {
      inspectionMode.value = false;
      selectedTargets.value = [];
      sources.value = [];
      articles.value = [];
      detail.value = null;
      detailError.value = null;
      detailArticleId.value = null;
      sourceCursor.value = null;
      articleCursor.value = null;
      sourceRequestSequence++;
      articleRequestSequence++;
      detailRequestSequence++;
    }
    void loadInspectionAccess(Boolean(userId));
  },
  { immediate: true },
);
onMounted(() => {
  // The server-side cookie is authoritative. Always probe it on mount because
  // legacy persisted client profiles may be authenticated but omit `user.id`.
  void loadInspectionAccess(true);
});
onBeforeUnmount(() => {
  accessRequestSequence++;
  if (debounceTimer) clearTimeout(debounceTimer);
  sourceRequestSequence++;
  articleRequestSequence++;
  detailRequestSequence++;
});
</script>
