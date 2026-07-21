<template>
  <div class="relative min-h-screen">
    <div
      class="fixed top-0 right-0 -z-10 h-[520px] w-[520px] rounded-full bg-neon-cyan/5 blur-[130px] pointer-events-none"
    />
    <div
      class="fixed bottom-[-12%] left-[-12%] -z-10 h-[520px] w-[520px] rounded-full bg-primary-container/5 blur-[150px] pointer-events-none"
    />

    <main class="relative z-10 mx-auto w-full max-w-5xl space-y-5 px-4 py-5">
      <section class="px-1">
        <div class="inline-block rounded-lg bg-surface-container-highest px-3 py-1">
          <span class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">
            Admin Operations
          </span>
        </div>
        <h1 class="mt-3 font-headline text-3xl font-bold leading-tight text-on-surface md:text-5xl">
          NuSift Admin Console
        </h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Pipeline controls, Agent 2 discovery diagnostics, headless queue recovery, and backend activity logs.
        </p>
      </section>

      <div
        v-if="toast.show"
        class="fixed bottom-4 left-1/2 z-[120] w-[min(92vw,28rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md"
        :class="toastClass"
      >
        <div class="flex items-start gap-3">
          <span class="material-symbols-outlined mt-0.5 text-[20px]">{{ toastIcon }}</span>
          <p class="text-sm font-medium leading-snug">{{ toast.message }}</p>
        </div>
      </div>

      <section
        v-if="!canAccessDevPanel"
        class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-6"
      >
        <h2 class="font-headline text-base font-bold text-on-surface">Admin access required</h2>
        <p class="mt-2 text-sm text-on-surface-variant">
          This page is only available for users listed in the server-side admin configuration.
        </p>
      </section>

      <section
        v-else
        class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4 space-y-5"
      >
        <div class="flex flex-col gap-3 rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="font-headline text-sm font-bold text-on-surface">
                Manual pipeline trigger
              </h2>
              <span
                class="rounded-full border border-primary-container/30 bg-primary-container/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-container"
              >
                {{ canUseFullDevTools ? "Dev" : "Admin" }}
              </span>
            </div>
            <p class="mt-1 text-xs text-on-surface-variant">
              Manually run Agent 1 RSS ingest, Agent 2 web discovery, Agent 3 enrichment, and queue maintenance.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="canRunManualPipeline"
              @click="runHardCaseQueue"
              :disabled="isHardCaseQueueRunning"
              class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isHardCaseQueueRunning ? "Running..." : "Run hard-case queue" }}
            </button>
            <button
              v-if="canRunManualPipeline"
              @click="enrichExistingArticles"
              :disabled="isEnrichingExistingArticles"
              class="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-bold text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isEnrichingExistingArticles ? "Enriching..." : "Enrich existing articles" }}
            </button>
            <button
              v-if="canRunArticleDiscovery"
              @click="runArticleDiscovery"
              :disabled="isArticleDiscoveryRunning"
              class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isArticleDiscoveryRunning ? "Discovering..." : "Run article discovery" }}
            </button>
            <button
              v-if="canRunManualPipeline"
              @click="runManualPipeline"
              :disabled="isPipelineRunning || !canRunManualPipeline"
              class="rounded-lg bg-primary-container px-4 py-2 text-sm font-bold text-on-primary-container transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isPipelineRunning ? "Running..." : "Run A1 -> A2 pipeline" }}
            </button>
          </div>
        </div>

        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 2 discovery quality
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Static discovery quality assessments and headless escalation queue.
              </p>
            </div>
            <button
              @click="loadDiscoveryQuality"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              Refresh
            </button>
          </div>

          <div v-if="discoveryQualityItems.length === 0" class="mt-3 text-xs text-on-surface-variant">
            No Agent 2 quality artifacts yet.
          </div>

          <div v-else class="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="item in discoveryQualityItems"
              :key="item.id"
              class="rounded-xl border px-3 py-2"
              :class="item.artifactType === 'article_discovery_headless_required'
                ? 'border-amber-500/15 bg-surface-container/50'
                : 'border-outline-variant/20 bg-surface-container'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="qualityBadgeClass(item.quality)"
                    >
                      {{ item.quality || "unknown" }}
                    </span>
                    <span v-if="item.confidence" class="text-[10px] text-on-surface-variant">confidence: {{ item.confidence }}</span>
                    <span v-if="item.shouldEscalateToHeadless" class="text-[10px] font-bold text-amber-300">Headless recommended</span>
                    <span
                      v-if="item.artifactType === 'article_discovery_headless_required'"
                      class="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300"
                    >
                      queue marker
                    </span>
                  </div>
                  <p class="mt-1 truncate text-[11px] text-on-surface-variant">
                    {{ item.targetUrl || item.sourceId || "unknown target" }}
                  </p>
                  <p v-if="item.explanation" class="mt-0.5 line-clamp-2 text-[10px] text-on-surface-variant/70">
                    {{ item.explanation }}
                  </p>
                  <div class="mt-1 flex flex-wrap gap-1.5">
                    <span
                      v-for="reason in (item.escalationReasons || []).slice(0, 3)"
                      :key="reason"
                      class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                    >
                      {{ reason }}
                    </span>
                  </div>
                  <div v-if="item.outcomeSummary" class="mt-1.5 flex flex-wrap gap-2 text-[10px] text-on-surface-variant">
                    <span>accepted: <strong class="text-emerald-300">{{ item.outcomeSummary.accepted }}</strong></span>
                    <span>rejected: <strong class="text-rose-300">{{ item.outcomeSummary.rejected }}</strong></span>
                    <span>total: <strong>{{ item.outcomeSummary.totalEvaluated }}</strong></span>
                    <span v-if="item.discoverySources?.listingPages">listing: {{ item.discoverySources.listingPages }}</span>
                    <span v-if="item.discoverySources?.sitemapUrls">sitemap: {{ item.discoverySources.sitemapUrls }}</span>
                    <span v-if="item.discoverySources?.jsonldUrls">jsonld: {{ item.discoverySources.jsonldUrls }}</span>
                  </div>
                  <!-- Stale samples -->
                  <div v-if="item.staleSamples && item.staleSamples.length > 0" class="mt-2 rounded-lg border border-amber-500/10 bg-amber-500/5 px-2.5 py-1.5">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-amber-300/80">
                      Stale samples ({{ item.staleSamples.length }})
                    </p>
                    <div
                      v-for="(sample, si) in item.staleSamples.slice(0, 3)"
                      :key="si"
                      class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                    >
                      <span class="font-medium text-amber-200">
                        {{ sample.staleReason ? staleReasonLabel(sample.staleReason) : '' }}
                      </span>
                      <span class="text-on-surface-variant/70">
                        {{ sample.normalizedPublishedAt ? sample.normalizedPublishedAt.slice(0, 10) : 'missing date' }}
                      </span>
                      <span v-if="sample.publishedAtSource" class="text-on-surface-variant/50">
                        {{ sample.publishedAtSource }}
                      </span>
                      <span v-if="sample.ageDays != null" class="text-on-surface-variant/50">
                        {{ sample.ageDays }}d
                      </span>
                      <a
                        v-if="sample.url"
                        :href="sample.url"
                        target="_blank"
                        rel="noopener"
                        class="truncate max-w-[200px] text-cyan-400/70 hover:text-cyan-300 hover:underline"
                      >
                        {{ truncateStaleUrl(sample.url) }}
                      </a>
                    </div>
                  </div>
                </div>
                <div class="shrink-0 text-right text-[10px] text-on-surface-variant">
                  <div>{{ formatLogTime(item.createdAt) }}</div>
                  <div v-if="item.sourceId" class="max-w-[80px] truncate">{{ item.sourceId }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 2 headless queue
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Headless fallback queue items and browser recovery controls.
              </p>
            </div>
            <button
              @click="loadHeadlessQueue"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              Refresh queue
            </button>
          </div>

          <div v-if="headlessQueueSummary" class="mt-3 flex flex-wrap gap-1.5">
            <span
              v-for="(count, status) in headlessQueueSummary.byStatus"
              :key="status"
              class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              :class="headlessStatusBadgeClass(status as string)"
            >
              {{ status }}: {{ count }}
            </span>
            <span class="ml-1 self-center text-[10px] text-on-surface-variant">
              {{ headlessQueueSummary.total }} total
            </span>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              v-if="canRunManualPipeline"
              @click="inspectHeadlessQueue"
              :disabled="isInspectingHeadless"
              class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isInspectingHeadless ? "Inspecting..." : "Inspect queue (dry-run)" }}
            </button>
            <button
              v-if="canRunManualPipeline"
              @click="runHeadlessBrowserFallback"
              :disabled="isRunningHeadlessBrowser"
              class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isRunningHeadlessBrowser ? "Running..." : "Run browser fallback" }}
            </button>
            <button
              v-if="canRunManualPipeline"
              @click="recoverStaleHeadless"
              :disabled="isRecoveringHeadless"
              class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isRecoveringHeadless ? "Recovering..." : "Recover stale" }}
            </button>
          </div>

          <div v-if="headlessBrowserEnvDisabled" class="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <p class="text-[11px] font-medium text-amber-200">
              Browser fallback is disabled by env (NUXT_ENABLE_AGENT2_BROWSER_FALLBACK).
            </p>
          </div>

          <div v-if="headlessQueueItems.length === 0 && !headlessQueueLoading" class="mt-3 text-xs text-on-surface-variant">
            No headless queue items found.
          </div>
          <div v-else-if="headlessQueueLoading" class="mt-3 text-xs text-on-surface-variant">
            Loading queue...
          </div>
          <div v-else class="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="item in headlessQueueItems"
              :key="item.id"
              class="rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="headlessStatusBadgeClass(item.status)"
                    >
                      {{ item.status }}
                    </span>
                    <span v-if="item.quality" class="text-[10px] text-on-surface-variant">q: {{ item.quality }}</span>
                    <span v-if="item.confidence" class="text-[10px] text-on-surface-variant">c: {{ item.confidence }}</span>
                    <span v-if="item.candidateCount != null && item.candidateCount > 0" class="text-[10px] font-medium text-emerald-300">
                      {{ item.candidateCount }} candidates
                    </span>
                    <span v-if="item.browserFallbackRan" class="text-[10px] font-medium text-sky-300">browser ran</span>
                  </div>
                  <p class="mt-1 truncate text-[11px] text-on-surface-variant">
                    {{ item.targetUrl || "no target url" }}
                  </p>
                  <div v-if="item.sourceId || item.categoryId" class="mt-0.5 flex flex-wrap gap-2 text-[10px] text-on-surface-variant/60">
                    <span v-if="item.sourceId">src: {{ item.sourceId.slice(0, 8) }}...</span>
                    <span v-if="item.categoryId">cat: {{ item.categoryId.slice(0, 8) }}...</span>
                  </div>
                  <div v-if="item.escalationReasons.length > 0" class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="reason in item.escalationReasons.slice(0, 3)"
                      :key="reason"
                      class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                    >
                      {{ reason }}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-2 text-[10px] text-on-surface-variant/50">
                    <span v-if="item.headlessProcessingStartedAt">started: {{ formatLogTime(item.headlessProcessingStartedAt) }}</span>
                    <span v-if="item.headlessRecoveryCount">recovered: {{ item.headlessRecoveryCount }}x</span>
                    <span v-if="item.lastHeadlessRecoveryAt">last recovery: {{ formatLogTime(item.lastHeadlessRecoveryAt) }}</span>
                  </div>
                  <!-- Browser fallback result metadata (compact) -->
                  <div v-if="item.browserFallbackRan" class="mt-2 rounded-lg border border-sky-500/15 bg-sky-500/5 px-2.5 py-1.5">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-[9px] font-bold uppercase tracking-wider text-sky-300/80">Browser fallback</span>
                      <span v-if="item.browserQualityAssessment?.quality" class="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" :class="qualityBadgeClass(item.browserQualityAssessment.quality)">
                        {{ item.browserQualityAssessment.quality }}
                      </span>
                      <span v-if="item.renderedUrl" class="text-[9px] text-on-surface-variant/50">rendered</span>
                    </div>
                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-on-surface-variant/80">
                      <span v-if="item.browserRawLinks != null">raw links: <strong>{{ item.browserRawLinks }}</strong></span>
                      <span v-if="item.browserEvaluated != null">evaluated: <strong>{{ item.browserEvaluated }}</strong></span>
                      <span v-if="item.browserAccepted != null">accepted: <strong class="text-emerald-300">{{ item.browserAccepted }}</strong></span>
                      <span v-if="item.browserRejected != null">rejected: <strong class="text-rose-300">{{ item.browserRejected }}</strong></span>
                      <span v-if="item.browserInserted != null">inserted: <strong class="text-emerald-300">{{ item.browserInserted }}</strong></span>
                      <span v-if="item.browserSkipped != null">skipped: <strong>{{ item.browserSkipped }}</strong></span>
                      <span v-if="item.browserFailed != null && item.browserFailed > 0">failed: <strong class="text-rose-300">{{ item.browserFailed }}</strong></span>
                    </div>
                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-on-surface-variant/80">
                      <span v-if="item.browserShortlistedLinks != null">shortlisted: <strong>{{ item.browserShortlistedLinks }}</strong></span>
                    </div>
                    <div v-if="item.browserTopRejectionReasons && item.browserTopRejectionReasons.length > 0" class="mt-1 flex flex-wrap gap-1">
                      <span
                        v-for="reason in item.browserTopRejectionReasons.slice(0, 5)"
                        :key="reason.reason"
                        class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                      >
                        {{ reason.reason }} ({{ reason.count }})
                      </span>
                    </div>
                    <div v-if="item.browserTopLinkRejectionReasons && item.browserTopLinkRejectionReasons.length > 0" class="mt-1 flex flex-wrap gap-1">
                      <span class="text-[9px] font-bold uppercase tracking-wider text-rose-300/70 mr-1">link filter:</span>
                      <span
                        v-for="reason in item.browserTopLinkRejectionReasons.slice(0, 5)"
                        :key="reason.reason"
                        class="rounded bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-medium text-rose-200"
                      >
                        {{ reason.reason }} ({{ reason.count }})
                      </span>
                    </div>
                    <!-- Top rejected links -->
                    <div v-if="item.browserTopRejectedLinks && item.browserTopRejectedLinks.length > 0" class="mt-1.5">
                      <p class="text-[9px] font-bold uppercase tracking-wider text-rose-300/70">
                        Top rejected links ({{ item.browserTopRejectedLinks.length }})
                      </p>
                      <div
                        v-for="(entry, ri) in item.browserTopRejectedLinks.slice(0, 5)"
                        :key="ri"
                        class="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                      >
                        <span class="rounded bg-rose-500/10 px-1 py-0.5 text-[8px] font-bold text-rose-200">
                          {{ entry.reason || 'unknown' }}
                        </span>
                        <span class="text-on-surface-variant/40">score: {{ entry.score }}</span>
                        <span v-if="entry.anchorText" class="text-on-surface-variant/40">"{{ entry.anchorText.slice(0, 40) }}"</span>
                        <a
                          v-if="entry.url"
                          :href="entry.url"
                          target="_blank"
                          rel="noopener"
                          class="truncate max-w-[200px] text-cyan-400/60 hover:text-cyan-300 hover:underline"
                        >
                          {{ truncateStaleUrl(entry.url) }}
                        </a>
                      </div>
                    </div>
                    <!-- Shortlisted link samples -->
                    <div v-if="item.browserShortlistedLinkSamples && item.browserShortlistedLinkSamples.length > 0" class="mt-1.5">
                      <p class="text-[9px] font-bold uppercase tracking-wider text-emerald-300/70">
                        Shortlisted links ({{ item.browserShortlistedLinkSamples.length }})
                      </p>
                      <div
                        v-for="(entry, si) in item.browserShortlistedLinkSamples.slice(0, 5)"
                        :key="si"
                        class="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                      >
                        <span class="text-emerald-300/70">score: {{ entry.score }}</span>
                        <span v-if="entry.anchorText" class="text-on-surface-variant/40">"{{ entry.anchorText.slice(0, 40) }}"</span>
                        <a
                          v-if="entry.url"
                          :href="entry.url"
                          target="_blank"
                          rel="noopener"
                          class="truncate max-w-[200px] text-cyan-400/60 hover:text-cyan-300 hover:underline"
                        >
                          {{ truncateStaleUrl(entry.url) }}
                        </a>
                      </div>
                    </div>
                    <div class="mt-1 flex flex-wrap gap-2 text-[9px] text-on-surface-variant/50">
                      <span v-if="item.browserFallbackStartedAt">started: {{ formatLogTime(item.browserFallbackStartedAt) }}</span>
                      <span v-if="item.browserFallbackFinishedAt">finished: {{ formatLogTime(item.browserFallbackFinishedAt) }}</span>
                    </div>
                    <p v-if="item.browserError" class="mt-1 line-clamp-2 text-[10px] text-rose-300/80">
                      {{ item.browserError }}
                    </p>
                    <p v-else-if="item.browserQualityAssessment?.explanation" class="mt-1 line-clamp-2 text-[10px] text-on-surface-variant/60">
                      {{ item.browserQualityAssessment.explanation }}
                    </p>
                  </div>
                  <!-- Stale samples (headless queue) -->
                  <div v-if="item.staleSamples && item.staleSamples.length > 0" class="mt-2 rounded-lg border border-amber-500/10 bg-amber-500/5 px-2.5 py-1.5">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-amber-300/80">
                      Stale samples ({{ item.staleSamples.length }})
                    </p>
                    <div
                      v-for="(sample, si) in item.staleSamples.slice(0, 3)"
                      :key="si"
                      class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                    >
                      <span class="font-medium text-amber-200">
                        {{ sample.staleReason ? staleReasonLabel(sample.staleReason) : '' }}
                      </span>
                      <span class="text-on-surface-variant/70">
                        {{ sample.normalizedPublishedAt ? sample.normalizedPublishedAt.slice(0, 10) : 'missing date' }}
                      </span>
                      <span v-if="sample.publishedAtSource" class="text-on-surface-variant/50">
                        {{ sample.publishedAtSource }}
                      </span>
                      <span v-if="sample.ageDays != null" class="text-on-surface-variant/50">
                        {{ sample.ageDays }}d
                      </span>
                      <a
                        v-if="sample.url"
                        :href="sample.url"
                        target="_blank"
                        rel="noopener"
                        class="truncate max-w-[200px] text-cyan-400/70 hover:text-cyan-300 hover:underline"
                      >
                        {{ truncateStaleUrl(sample.url) }}
                      </a>
                    </div>
                  </div>
                </div>
                <div class="shrink-0 text-right text-[10px] text-on-surface-variant">
                  <div>{{ formatLogTime(item.createdAt) }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 2 hard sources
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Targets where static + browser fallback both failed. AI-inspection candidates for future admin-only profile generation.
              </p>
            </div>
            <button
              @click="loadHardSources"
              :disabled="hardSourcesLoading"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ hardSourcesLoading ? "Loading..." : "Refresh" }}
            </button>
          </div>

          <div v-if="hardSources.length === 0 && !hardSourcesLoading" class="mt-3 text-xs text-on-surface-variant">
            No hard sources detected. Either all targets are productive statically, or browser fallback resolved the remaining ones.
          </div>
          <div v-else-if="hardSourcesLoading" class="mt-3 text-xs text-on-surface-variant">
            Loading hard sources...
          </div>
          <div v-else class="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="entry in hardSources"
              :key="entry.key"
              class="rounded-xl border px-3 py-2"
              :class="entry.recommendedNextAction === 'ai_inspection_candidate'
                ? 'border-fuchsia-500/20 bg-fuchsia-500/5'
                : 'border-outline-variant/20 bg-surface-container'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="hardSourceActionBadgeClass(entry.recommendedNextAction)"
                    >
                      {{ hardSourceActionLabel(entry.recommendedNextAction) }}
                    </span>
                    <span v-if="entry.lastStaticQuality" class="text-[10px] text-on-surface-variant">static: {{ entry.lastStaticQuality }}</span>
                    <span v-if="entry.lastBrowserStatus" class="text-[10px] text-on-surface-variant">browser: {{ entry.lastBrowserStatus }}</span>
                    <span v-if="entry.consecutiveFailedDiscoveryAttempts > 0" class="text-[10px] font-medium text-rose-300">
                      {{ entry.consecutiveFailedDiscoveryAttempts }}x failed
                    </span>
                  </div>
                  <p class="mt-1 truncate text-[11px] text-on-surface-variant">
                    {{ entry.targetUrl }}
                  </p>
                  <div class="mt-0.5 flex flex-wrap gap-2 text-[10px] text-on-surface-variant/60">
                    <span v-if="entry.sourceId">src: {{ entry.sourceId.slice(0, 8) }}...</span>
                    <span v-if="entry.categoryId">cat: {{ entry.categoryId.slice(0, 8) }}...</span>
                    <span v-if="entry.lastAcceptedCount != null">accepted: {{ entry.lastAcceptedCount }}</span>
                    <span v-if="entry.lastInsertedCount != null">inserted: {{ entry.lastInsertedCount }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent logs
              </h3>
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
                v-if="canRunDestructiveActions"
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

          <div v-else class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="log in agentLogs"
              :key="log.id"
              class="rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-bold text-on-surface">{{ log.displayStatus || log.status }}</span>
                    <span v-if="log.sourceId" class="text-[10px] text-on-surface-variant">source: {{ log.sourceId }}</span>
                  </div>
                  <p class="mt-1 line-clamp-2 text-xs text-on-surface-variant">
                    {{ log.errorLog || "No details." }}
                  </p>
                </div>
                <div class="shrink-0 text-right text-[10px] text-on-surface-variant">
                  <div>{{ formatLogTime(log.createdAt) }}</div>
                  <div>{{ log.executionTimeMs }}ms</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useFeedStore } from "~/stores/feedStore";
import { $api } from "~/utils/api";

definePageMeta({
  layout: "app-layout",
});

const authStore = useAuthStore();
const feedStore = useFeedStore();

const canAccessDevPanel = ref(false);
const canRunManualPipeline = ref(false);
const canRunArticleDiscovery = ref(false);
const canRunDestructiveActions = ref(false);
const canUseFullDevTools = ref(false);
const isPipelineRunning = ref(false);
const isEnrichingExistingArticles = ref(false);
const isArticleDiscoveryRunning = ref(false);
const isHardCaseQueueRunning = ref(false);
const isClearingLogs = ref(false);
const isInspectingHeadless = ref(false);
const isRunningHeadlessBrowser = ref(false);
const isRecoveringHeadless = ref(false);
const headlessQueueLoading = ref(false);

const toast = ref({ show: false, message: "", type: "success" as "success" | "error" });

type StaleSample = {
  url: string;
  normalizedPublishedAt: string | null;
  publishedAtSource: string | null;
  ageDays: number | null;
  staleReason: string | null;
};

const discoveryQualityItems = ref<Array<{
  id: string;
  createdAt: string;
  sourceId: string | null;
  categoryId: string | null;
  artifactType: string;
  status: string;
  candidateCount: number | null;
  targetUrl: string | null;
  quality: string | null;
  confidence: string | null;
  shouldEscalateToHeadless: boolean;
  escalationReasons: string[];
  explanation: string | null;
  staleSamples: StaleSample[];
  outcomeSummary: { totalEvaluated: number; accepted: number; rejected: number; byStatus: Record<string, number>; topRejectionReasons: Array<{ reason: string; count: number }> };
  discoverySources: { listingPages: number; sitemapUrls: number; jsonldUrls: number };
}>>([]);

type BrowserTopRejectionReason = { reason: string; count: number };
type BrowserLinkAuditEntry = {
  url: string;
  normalizedUrl: string | null;
  anchorText: string | null;
  score: number;
  rejected: boolean;
  reason: string | null;
  scoreReasons: string[];
  sameDomain: boolean;
  utilityPath: boolean;
  categoryScoped: boolean | null;
};
type BrowserQualityAssessment = {
  quality: string | null;
  confidence: string | null;
  shouldEscalateToHeadless: boolean;
  escalationReasons: string[];
  explanation: string | null;
};

const headlessQueueItems = ref<Array<{
  id: string;
  status: string;
  artifactType: string;
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
  createdAt: string;
  updatedAt: string;
  quality: string | null;
  confidence: string | null;
  escalationReasons: string[];
  headlessProcessingStartedAt: string | null;
  headlessRecoveryCount: number | null;
  lastHeadlessRecoveryAt: string | null;
  browserFallbackRan: boolean;
  candidateCount: number | null;
  staleSamples: StaleSample[];
  // Compact browser fallback result metadata
  browserFallbackStartedAt: string | null;
  browserFallbackFinishedAt: string | null;
  browserRawLinks: number | null;
  browserEvaluated: number | null;
  browserAccepted: number | null;
  browserRejected: number | null;
  browserInserted: number | null;
  browserSkipped: number | null;
  browserFailed: number | null;
  browserTopRejectionReasons: BrowserTopRejectionReason[];
  browserError: string | null;
  browserQualityAssessment: BrowserQualityAssessment | null;
  renderedUrl: string | null;
  browserShortlistedLinks: number | null;
  browserTopRejectedLinks: BrowserLinkAuditEntry[];
  browserShortlistedLinkSamples: BrowserLinkAuditEntry[];
  browserTopLinkRejectionReasons: BrowserTopRejectionReason[];
}>>([]);

type HardSourceEntry = {
  key: string;
  targetUrl: string;
  sourceId: string;
  categoryId: string | null;
  lastStaticQuality: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  lastInsertedCount: number | null;
  consecutiveFailedDiscoveryAttempts: number;
  recommendedNextAction: string;
};

const hardSources = ref<HardSourceEntry[]>([]);
const hardSourcesLoading = ref(false);

const headlessQueueSummary = ref<{ total: number; byStatus: Record<string, number> } | null>(null);
const headlessBrowserEnvDisabled = ref(false);
const agentLogs = ref<Array<{ id: string; status: string; displayStatus?: string; agentPrefix?: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }>>([]);
const agentSourceCount = ref(0);

const toastClass = computed(() =>
  toast.value.type === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100",
);
const toastIcon = computed(() => (toast.value.type === "success" ? "check_circle" : "error"));
const isAdminUser = computed(() => authStore.user?.isAdmin === true || authStore.user?.role === "ADMIN");
const showAdminPipelinePanel = computed(() => canAccessDevPanel.value);
const showFullDevTools = computed(() => canAccessDevPanel.value && canUseFullDevTools.value);

let devPanelPollTimer: number | null = null;
const DEV_PANEL_POLL_MS = 10000;

const formatLogTime = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const showToast = (message: string, type: "success" | "error" = "success", timeout = 5000) => {
  toast.value = { show: true, message, type };
  window.setTimeout(() => {
    toast.value.show = false;
  }, timeout);
};

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

const checkDevPanelAccess = async () => {
  if (!isAdminUser.value) {
    canAccessDevPanel.value = false;
    canRunManualPipeline.value = false;
    canRunArticleDiscovery.value = false;
    canRunDestructiveActions.value = false;
    canUseFullDevTools.value = false;
    stopDevPanelPolling();
    return false;
  }

  try {
    const response = await fetch("/api/dev/access", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canRunArticleDiscovery.value = false;
      canRunDestructiveActions.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return false;
    }

    const payload = (await response.json()) as {
      ok: boolean;
      canAccess: boolean;
      manualPipelineEnabled?: boolean;
      manualArticleDiscoveryEnabled?: boolean;
      destructiveActionsEnabled?: boolean;
      diagnosticsEnabled?: boolean;
    };
    canAccessDevPanel.value = payload.canAccess === true;
    canRunManualPipeline.value = payload.manualPipelineEnabled !== false;
    canRunArticleDiscovery.value = payload.manualArticleDiscoveryEnabled === true;
    canRunDestructiveActions.value = payload.destructiveActionsEnabled === true;
    canUseFullDevTools.value = payload.diagnosticsEnabled === true;
    return canAccessDevPanel.value;
  } catch {
    canAccessDevPanel.value = false;
    canRunManualPipeline.value = false;
    canRunArticleDiscovery.value = false;
    canRunDestructiveActions.value = false;
    canUseFullDevTools.value = false;
    stopDevPanelPolling();
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
  const response = await $api<{ ok: boolean; logs: typeof agentLogs.value }>("/api/dev/agent-logs");
  agentLogs.value = response.logs || [];
};

const loadEligibleSourceCount = async () => {
  if (!showFullDevTools.value) return;
  const response = await $api<{ ok: boolean; count: number }>("/api/dev/agent-source-count");
  agentSourceCount.value = response.count || 0;
};

const loadDiscoveryQuality = async () => {
  if (!showFullDevTools.value) return;
  const response = await $api<{ ok: boolean; items: typeof discoveryQualityItems.value }>("/api/dev/article-discovery-quality");
  discoveryQualityItems.value = response.items || [];
};

const loadHeadlessQueue = async () => {
  if (!showFullDevTools.value) return;
  headlessQueueLoading.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      items: typeof headlessQueueItems.value;
      summary: { total: number; byStatus: Record<string, number> };
      browserFallbackEnabled: boolean;
    }>("/api/dev/article-discovery-headless-queue");
    headlessQueueItems.value = response.items || [];
    headlessQueueSummary.value = response.summary || null;
    headlessBrowserEnvDisabled.value = !response.browserFallbackEnabled;
  } finally {
    headlessQueueLoading.value = false;
  }
};

const loadHardSources = async () => {
  if (!showFullDevTools.value) return;
  hardSourcesLoading.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      report: {
        generatedAt: string;
        scannedArtifacts: number;
        hardSources: HardSourceEntry[];
        total: number;
      };
    }>("/api/dev/article-discovery-hard-sources");
    hardSources.value = response.report?.hardSources || [];
  } catch (error) {
    console.error("Failed to load hard sources:", error);
    hardSources.value = [];
  } finally {
    hardSourcesLoading.value = false;
  }
};

const refreshDevPanel = async () => {
  if (!showFullDevTools.value) return;
  try {
    await Promise.all([
      loadAgentLogs(),
      loadEligibleSourceCount(),
      loadDiscoveryQuality(),
      loadHeadlessQueue(),
      loadHardSources(),
    ]);
  } catch (error) {
    console.error("Failed to refresh admin panel:", error);
  }
};

const clearAgentLogs = async () => {
  if (!showFullDevTools.value || !canRunDestructiveActions.value || isClearingLogs.value) return;
  isClearingLogs.value = true;
  try {
    const response = await $api<{ ok: boolean; deletedCount: number; articleCount?: number; artifactCount?: number; runCount?: number }>("/api/dev/agent-logs", {
      method: "DELETE",
    });
    agentLogs.value = [];
    await feedStore.fetchFeed({ force: true });
    showToast(`Cleared ${response.articleCount ?? 0} article(s), ${response.deletedCount ?? 0} agent log(s), ${response.artifactCount ?? 0} artifact(s), and ${response.runCount ?? 0} pipeline run(s).`, "success", 3000);
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Failed to clear logs.", "error");
  } finally {
    isClearingLogs.value = false;
  }
};

const runManualPipeline = async () => {
  if (!showAdminPipelinePanel.value || isPipelineRunning.value) return;
  isPipelineRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{ ok: boolean; result?: any }>("/api/dev/run-news-pipeline", { method: "POST" });
    showToast(`Pipeline finished: ${response.result?.inserted ?? 0} inserted, ${response.result?.skipped ?? 0} skipped, ${response.result?.failed ?? 0} failed.`, "success", 3500);
    await feedStore.fetchFeed({ force: true });
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Pipeline run failed.", "error");
  } finally {
    isPipelineRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const runArticleDiscovery = async () => {
  if (!showFullDevTools.value || !canRunArticleDiscovery.value || isArticleDiscoveryRunning.value) return;
  isArticleDiscoveryRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      targets?: number;
      sourcesScanned?: number;
      inserted?: number;
      skipped?: number;
      failed?: number;
    }>("/api/dev/run-article-discovery", { method: "POST" });
    showToast(`Article discovery finished: ${response.inserted ?? 0} inserted, ${response.skipped ?? 0} skipped, ${response.failed ?? 0} failed from ${response.sourcesScanned ?? response.targets ?? 0} target(s).`);
    await feedStore.fetchFeed({ force: true });
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Article discovery failed.", "error");
  } finally {
    isArticleDiscoveryRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const enrichExistingArticles = async () => {
  if (!showAdminPipelinePanel.value || isEnrichingExistingArticles.value) return;
  isEnrichingExistingArticles.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{ ok: boolean; scanned: number; updated: number; tagged: number }>("/api/dev/enrich-existing-articles", {
      method: "POST",
    });
    showToast(`Enrichment finished: ${response.updated ?? 0} category link(s) and ${response.tagged ?? 0} tag set(s) updated from ${response.scanned ?? 0} scanned article(s).`);
    await feedStore.fetchFeed({ force: true });
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Article enrichment failed.", "error");
  } finally {
    isEnrichingExistingArticles.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const runHardCaseQueue = async () => {
  if (!showFullDevTools.value || !canRunManualPipeline.value || isHardCaseQueueRunning.value) return;
  isHardCaseQueueRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      result?: { resolved: number; failedFinal: number; invalid: number };
    }>("/api/dev/run-hard-case-discovery", {
      method: "POST",
      body: { limit: 10 },
    });
    showToast(`Hard-case queue finished: ${response.result?.resolved ?? 0} resolved, ${response.result?.failedFinal ?? 0} failed, ${response.result?.invalid ?? 0} invalid.`);
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Hard-case queue run failed.", "error");
  } finally {
    isHardCaseQueueRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const inspectHeadlessQueue = async () => {
  if (!showFullDevTools.value || !canRunManualPipeline.value || isInspectingHeadless.value) return;
  isInspectingHeadless.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      result: { inspected: number; wouldProcess: number; skippedInvalid: number };
    }>("/api/dev/run-article-discovery-headless-queue", {
      method: "POST",
      body: { dryRun: true, limit: 10 },
    });
    const r = response.result;
    showToast(`Inspect: ${r.inspected ?? 0} inspected, ${r.wouldProcess ?? 0} would process, ${r.skippedInvalid ?? 0} invalid.`);
    await loadHeadlessQueue();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Headless queue inspection failed.", "error");
  } finally {
    isInspectingHeadless.value = false;
  }
};

const runHeadlessBrowserFallback = async () => {
  if (!showFullDevTools.value || !canRunManualPipeline.value || isRunningHeadlessBrowser.value) return;
  isRunningHeadlessBrowser.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      result: {
        skippedInvalid: number;
        skippedAlreadyClaimed: number;
        browserResolved?: number;
        browserNoCandidates?: number;
        browserSkippedDisabled?: number;
        browserSkippedUnavailable?: number;
        browserFailed?: number;
        browserCandidatesFound?: number;
        browserCandidatesPersisted?: { inserted: number; skipped: number; failed: number };
      };
      browserFallbackEnabled: boolean;
    }>("/api/dev/run-article-discovery-headless-queue", {
      method: "POST",
      body: { dryRun: false, runBrowser: true, limit: 3 },
    });
    const r = response.result;
    headlessBrowserEnvDisabled.value = !response.browserFallbackEnabled;
    const persisted = r.browserCandidatesPersisted;
    if (r.browserSkippedDisabled && r.browserSkippedDisabled > 0) {
      showToast(`Browser fallback disabled by env. ${r.browserSkippedDisabled} artifact(s) marked BROWSER_FALLBACK_DISABLED.`, "error");
    } else if (r.browserSkippedUnavailable && r.browserSkippedUnavailable > 0) {
      showToast(`Browser runtime unavailable for ${r.browserSkippedUnavailable} target(s). Resolved ${r.browserResolved ?? 0}, no-candidates ${r.browserNoCandidates ?? 0}, already-claimed ${r.skippedAlreadyClaimed ?? 0}. Install Playwright to enable browser fallback.`, "error");
    } else {
      const insertedText = persisted ? `, inserted ${persisted.inserted}/skipped ${persisted.skipped}/failed ${persisted.failed} candidates` : "";
      showToast(`Browser: ${r.browserResolved ?? 0} resolved, ${r.browserNoCandidates ?? 0} no-candidates, ${r.browserFailed ?? 0} errors, ${r.browserCandidatesFound ?? 0} found${insertedText}. Already-claimed ${r.skippedAlreadyClaimed ?? 0}, invalid ${r.skippedInvalid ?? 0}.`);
    }
    // Refresh the full admin panel so the browser results, discovery quality,
    // agent logs, and hard-source report all reflect the latest run.
    await refreshDevPanel();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Browser fallback run failed.", "error");
  } finally {
    isRunningHeadlessBrowser.value = false;
  }
};

const recoverStaleHeadless = async () => {
  if (!showFullDevTools.value || !canRunManualPipeline.value || isRecoveringHeadless.value) return;
  isRecoveringHeadless.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      result: { inspected: number; staleFound: number; recovered: number; failedStale: number; skippedAlreadyChanged: number };
    }>("/api/dev/recover-article-discovery-headless-queue", {
      method: "POST",
      body: { mode: "retry", olderThanMinutes: 30, limit: 10 },
    });
    const r = response.result;
    showToast(`Recovery: ${r.inspected ?? 0} inspected, ${r.staleFound ?? 0} stale found, ${r.recovered ?? 0} recovered, ${r.failedStale ?? 0} failed, ${r.skippedAlreadyChanged ?? 0} already changed.`);
    await loadHeadlessQueue();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Stale headless recovery failed.", "error");
  } finally {
    isRecoveringHeadless.value = false;
  }
};

const staleReasonLabel = (reason: string | null): string => {
  if (!reason) return "";
  const labels: Record<string, string> = {
    published_at_before_cutoff: "before cutoff",
    missing_published_at: "missing date",
    invalid_published_at: "invalid date",
    future_published_at: "future date",
    unknown: "unknown",
  };
  return labels[reason] || reason;
};

const truncateStaleUrl = (url: string, maxLen = 50): string => {
  if (!url || url.length <= maxLen) return url || "";
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, "");
    const path = u.pathname;
    const budget = maxLen - domain.length - 1;
    if (path.length <= budget) return `${domain}${path}`;
    const halfBudget = Math.floor(budget / 2) - 2;
    return `${domain}${path.slice(0, halfBudget)}...${path.slice(-halfBudget)}`;
  } catch {
    return url.length > maxLen ? `${url.slice(0, maxLen - 3)}...` : url;
  }
};

const qualityBadgeClass = (quality: string | null) => ({
  "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20": quality === "productive",
  "bg-amber-500/15 text-amber-300 border border-amber-500/20": quality === "weak",
  "bg-rose-500/15 text-rose-300 border border-rose-500/20": quality === "failed",
  "bg-red-500/15 text-red-300 border border-red-500/30": quality === "blocked",
  "bg-gray-500/15 text-gray-400 border border-gray-500/20": !quality,
});

const headlessStatusBadgeClass = (status: string) => {
  switch (status) {
    case "PENDING_HEADLESS":
      return "bg-amber-500/15 text-amber-300 border-amber-500/20";
    case "HEADLESS_PROCESSING":
      return "bg-sky-500/15 text-sky-300 border-sky-500/20";
    case "RESOLVED":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/20";
    case "BROWSER_NO_CANDIDATES":
      return "bg-orange-500/15 text-orange-300 border-orange-500/20";
    case "BROWSER_RUNTIME_UNAVAILABLE":
      return "bg-rose-500/15 text-rose-300 border-rose-500/20";
    case "BROWSER_FALLBACK_DISABLED":
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
    case "HEADLESS_PROCESSING_STALE":
      return "bg-red-500/15 text-red-300 border-red-500/30";
    case "INVALID":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "SKIPPED_UNIMPLEMENTED":
      return "bg-slate-500/15 text-slate-400 border-slate-500/20";
    case "RESOLVED_BY_STATIC_DISCOVERY":
      return "bg-teal-500/15 text-teal-300 border-teal-500/20";
    default:
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
  }
};

const hardSourceActionLabel = (action: string): string => {
  const labels: Record<string, string> = {
    retry_static: "retry static",
    run_browser: "run browser",
    manual_review: "manual review",
    ai_inspection_candidate: "AI inspection",
  };
  return labels[action] || action;
};

const hardSourceActionBadgeClass = (action: string): string => {
  switch (action) {
    case "ai_inspection_candidate":
      return "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/20";
    case "run_browser":
      return "bg-sky-500/15 text-sky-300 border-sky-500/20";
    case "retry_static":
      return "bg-amber-500/15 text-amber-300 border-amber-500/20";
    case "manual_review":
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
    default:
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
  }
};

onMounted(() => {
  void initializeDevPanel();
});

onBeforeUnmount(() => {
  stopDevPanelPolling();
});

watch(
  () => authStore.user?.id || null,
  (userId) => {
    if (!userId || !isAdminUser.value) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canRunArticleDiscovery.value = false;
      canRunDestructiveActions.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    void initializeDevPanel();
  },
);

watch(
  () => authStore.user?.isAdmin === true || authStore.user?.role === "ADMIN",
  (isAdmin) => {
    if (!isAdmin) {
      canAccessDevPanel.value = false;
      canRunManualPipeline.value = false;
      canRunArticleDiscovery.value = false;
      canRunDestructiveActions.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    void initializeDevPanel();
  },
);
</script>
