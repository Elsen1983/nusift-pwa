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

      <template v-else>
        <section
          v-if="showFullDevTools"
          class="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-4 shadow-lg shadow-cyan-950/10"
        >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="material-symbols-outlined text-[19px] text-cyan-300">monitoring</span>
              <h2 class="font-headline text-base font-bold text-on-surface">Daily pipeline telemetry</h2>
              <span v-if="dailyPipelineTelemetry.run" class="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider" :class="dailyPipelineTelemetry.run.status.includes('FAILED') || dailyPipelineTelemetry.run.status.includes('STALE') ? 'bg-rose-500/15 text-rose-200' : dailyPipelineTelemetry.run.status.includes('RUNNING') || dailyPipelineTelemetry.run.status.includes('PARTIAL') ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'">
                {{ dailyPipelineTelemetry.run.status.replace('DAILY_PIPELINE_WORKFLOW_', '') }}
              </span>
            </div>
            <p class="mt-1 text-xs text-on-surface-variant">Observation-only stage timing and concurrency diagnostics. Refreshes with the existing guarded admin poll.</p>
          </div>
          <button @click="loadDailyPipelineTelemetry" :disabled="dailyPipelineTelemetry.loading" class="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-400/20 disabled:opacity-60">
            {{ dailyPipelineTelemetry.loading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
        <p v-if="dailyPipelineTelemetry.loading && !dailyPipelineTelemetry.loaded" class="mt-4 text-xs text-on-surface-variant">Loading the latest workflow run...</p>
        <p v-else-if="dailyPipelineTelemetry.error" class="mt-4 rounded-lg border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">{{ dailyPipelineTelemetry.error }}</p>
        <p v-else-if="dailyPipelineTelemetry.loaded && !dailyPipelineTelemetry.run" class="mt-4 text-xs text-on-surface-variant">No daily pipeline workflow telemetry is available yet.</p>
        <div v-else-if="dailyPipelineTelemetry.run" class="mt-4 space-y-3">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-lg bg-surface-container/70 px-3 py-2"><div class="text-[9px] uppercase tracking-wider text-on-surface-variant">Workflow</div><div class="mt-1 text-xs font-bold text-on-surface">{{ formatTelemetryMs(dailyPipelineTelemetry.run.workflowDurationMs) }}</div></div>
            <div class="rounded-lg bg-surface-container/70 px-3 py-2"><div class="text-[9px] uppercase tracking-wider text-on-surface-variant">Slowest stage</div><div class="mt-1 text-xs font-bold text-cyan-200">{{ dailyPipelineTelemetry.slowestStage || '—' }}</div></div>
            <div class="rounded-lg bg-surface-container/70 px-3 py-2"><div class="text-[9px] uppercase tracking-wider text-on-surface-variant">Batches</div><div class="mt-1 text-xs font-bold text-on-surface">{{ dailyPipelineTelemetry.batches.length }}<span v-if="dailyPipelineTelemetry.pagination.truncated" class="ml-1 text-amber-200">+</span></div></div>
            <div class="rounded-lg bg-surface-container/70 px-3 py-2"><div class="text-[9px] uppercase tracking-wider text-on-surface-variant">Notifications</div><div class="mt-1 text-xs font-bold text-on-surface">{{ formatTelemetryMs(dailyPipelineTelemetry.run.notificationsDurationMs) }}</div></div>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-on-surface-variant">
            <span>processed targets/articles: <strong class="text-on-surface">{{ telemetryProcessed }}</strong></span><span>succeeded targets/articles: <strong class="text-emerald-300">{{ telemetrySucceeded }}</strong></span><span>retryable failed: {{ telemetryCount('failedRetryable') }}</span><span>permanent failed: {{ telemetryCount('failedPermanent') }}</span><span>skipped: {{ telemetryCount('skipped') }}</span><span>deferred: {{ telemetryCount('deferred') }}</span><span>quarantined: {{ telemetryCount('quarantined') }}</span><span>claim lost: {{ telemetryCount('claimLost') }}</span><span>persistence failed: {{ telemetryCount('persistenceFailed') }}</span><span>logical request: {{ formatTelemetryMs(telemetryDuration('logicalRequestDurationMs')) }}</span><span>extraction: {{ formatTelemetryMs(telemetryDuration('extractionDurationMs')) }}</span><span>browser: {{ formatTelemetryMs(telemetryDuration('browserDurationMs')) }}</span><span>persistence: {{ formatTelemetryMs(telemetryDuration('persistenceDurationMs')) }}</span><span>sleep: {{ formatTelemetryMs(telemetryDuration('sleepDurationMs')) }}</span><span>403 denied: {{ telemetryCount('accessDenied403') }}</span><span>403 limit: {{ telemetryCount('rateLimited403') }}</span><span>429: <strong class="text-amber-200">{{ telemetryCount('rateLimited429') }}</strong></span><span>timeouts: {{ telemetryCount('timedOut') }}</span>
          </div>
          <div v-if="dailyPipelineTelemetry.run.stageOutcomes?.length" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div v-for="outcome in dailyPipelineTelemetry.run.stageOutcomes" :key="outcome.stage" class="rounded-lg border border-outline-variant/15 bg-surface-container/50 px-3 py-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-bold text-on-surface">{{ outcome.stage }}</span>
                <span class="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" :class="outcome.status === 'completed' ? 'bg-emerald-500/15 text-emerald-200' : outcome.status === 'degraded' ? 'bg-amber-500/15 text-amber-200' : 'bg-rose-500/15 text-rose-200'">{{ outcome.status }}</span>
              </div>
              <p class="mt-1 text-[10px] text-on-surface-variant">{{ outcome.batchCount }} batch{{ outcome.batchCount === 1 ? '' : 'es' }} Â· remaining {{ outcome.actionableRemaining ?? outcome.remaining ?? 'â€”' }}</p>
              <p v-if="outcome.reason" class="mt-1 break-words text-[10px]" :class="outcome.status === 'failed' ? 'text-rose-200' : 'text-amber-200'">{{ outcome.reason }}</p>
              <p v-if="outcome.nextRetryAt" class="mt-1 text-[10px] text-amber-200">next retry: {{ formatLogTime(outcome.nextRetryAt) }}</p>
            </div>
          </div>
          <div class="space-y-2">
            <div v-for="stage in dailyPipelineTelemetry.stageTimings" :key="stage.stage" class="rounded-lg border border-outline-variant/15 bg-surface-container/50 px-3 py-2">
              <div class="flex flex-wrap items-center justify-between gap-2"><span class="text-xs font-bold text-on-surface">{{ stage.stage }}</span><span class="text-[10px] text-on-surface-variant">{{ formatTelemetryMs(stage.durationMs) }} · {{ stage.batches }} batch{{ stage.batches === 1 ? '' : 'es' }}</span></div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-on-surface-variant"><span>processed targets/articles {{ stage.processed }} / succeeded {{ stage.succeeded }}</span><span>failed {{ stage.failedRetryable }} retryable · {{ stage.failedPermanent }} permanent · skipped {{ stage.skipped }}</span><span>deferred {{ stage.deferred }} · quarantined {{ stage.quarantined }} · claim lost {{ stage.claimLost || 0 }} · persistence failed {{ stage.persistenceFailed || 0 }}</span><span>batch size {{ stage.batchSizeLimit }} / concurrency {{ stage.concurrencyLimit }} / peak {{ stage.peakConcurrency }}</span><span>logical request {{ formatTelemetryMs(stage.logicalRequestDurationMs) }} · extraction {{ formatTelemetryMs(stage.extractionDurationMs) }} · browser {{ formatTelemetryMs(stage.browserDurationMs) }} · persistence {{ formatTelemetryMs(stage.persistenceDurationMs) }} · sleep {{ formatTelemetryMs(stage.sleepDurationMs) }}</span><span>remaining {{ stage.remainingBefore ?? '—' }} → {{ stage.remainingAfter ?? '—' }}</span><span>403 denied {{ stage.accessDenied403 }} · 403 limit {{ stage.rateLimited403 }} · 429 {{ stage.rateLimited429 }}</span><span v-if="stage.productivity && Object.keys(stage.productivity).length > 0" class="text-cyan-200">productivity counters are separate</span><span v-if="stage.latestNoProgressReason" class="text-rose-200">no progress: {{ stage.latestNoProgressReason }}</span></div>
            </div>
          </div>
          <div
            v-if="dailyPipelineTelemetry.run.completion"
            class="rounded-xl border border-violet-400/20 bg-violet-500/5 px-3 py-2.5 text-[11px] text-on-surface-variant"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full bg-violet-400/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-200">
                Agent 3 completion
              </span>
              <strong class="text-on-surface">
                {{ dailyPipelineTelemetry.run.completion.currentRunDrained ? 'Current orchestration drained' : 'Current orchestration still has actionable work' }}
              </strong>
              <span v-if="dailyPipelineTelemetry.run.completion.globallyComplete" class="text-emerald-300">· Globally complete</span>
            </div>
            <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              <span>future-run eligible: <strong class="text-violet-200">{{ dailyPipelineTelemetry.run.completion.eligibleNextRun }}</strong></span>
              <span>future-run retryable: <strong class="text-emerald-300">{{ dailyPipelineTelemetry.run.completion.retryableNextRun }}</strong></span>
              <span v-if="dailyPipelineTelemetry.run.completion.deferred > 0" class="text-amber-200">deferred: {{ dailyPipelineTelemetry.run.completion.deferred }}</span>
              <span v-if="dailyPipelineTelemetry.run.completion.quarantined > 0" class="text-rose-200">quarantined: {{ dailyPipelineTelemetry.run.completion.quarantined }}</span>
              <span v-if="dailyPipelineTelemetry.run.completion.nonRetryable > 0" class="text-rose-200">non-retryable: {{ dailyPipelineTelemetry.run.completion.nonRetryable }}</span>
              <span v-if="dailyPipelineTelemetry.run.completion.nextRetryAt" class="text-amber-200">next retry: {{ formatLogTime(dailyPipelineTelemetry.run.completion.nextRetryAt) }}</span>
            </div>
            <p v-if="!dailyPipelineTelemetry.run.completion.globallyComplete && dailyPipelineTelemetry.run.completion.eligibleNextRun > 0" class="mt-1 text-[10px] text-violet-200/80">
              {{ dailyPipelineTelemetry.run.completion.eligibleNextRun }} articles eligible for a future run; this COMPLETED status describes the current orchestration only.
            </p>
          </div>
          <p v-else-if="dailyPipelineTelemetry.run.status.includes('COMPLETED')" class="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200">
            Completion queue details are not available for this legacy run.
          </p>
          <p v-if="dailyPipelineTelemetry.pagination.truncated" class="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-[10px] font-medium text-amber-200">Data truncated: showing the first 200 valid telemetry batches.</p>
          <p v-if="dailyPipelineTelemetry.latestNoProgressReason" class="rounded-lg border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-[10px] text-rose-200">Latest no-progress reason: {{ dailyPipelineTelemetry.latestNoProgressReason }}</p>
          <p v-if="dailyPipelineTelemetry.stale" class="text-[10px] text-amber-200">This run is stale or has not completed recently.</p>
          <div v-if="dailyPipelineTelemetry.run.status === 'DAILY_PIPELINE_WORKFLOW_RUNNING'" class="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-100">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span>Last lock heartbeat: <strong>{{ formatTelemetryMs(dailyPipelineTelemetry.run.lockHeartbeatAgeMs) }} ago</strong></span>
              <button v-if="dailyPipelineTelemetry.run.lockRecoveryEligible" @click="dailyLockRecoveryModalOpen = true" class="rounded border border-rose-400/25 bg-rose-400/10 px-2 py-1 font-bold text-rose-100">Release stale lock</button>
            </div>
            <p class="mt-1 text-[9px] text-on-surface-variant">Only use recovery after confirming that Vercel shows no active daily pipeline workflow.</p>
          </div>
          <div v-if="dailyLockRecoveryModalOpen && dailyPipelineTelemetry.run" class="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
            <div class="w-full max-w-md rounded-2xl border border-rose-400/20 bg-surface-container-high p-4 shadow-2xl">
              <h3 class="font-headline text-sm font-bold text-on-surface">Release stale daily pipeline lock?</h3>
              <p class="mt-2 text-xs leading-relaxed text-on-surface-variant">Confirm in Vercel that no daily pipeline workflow is Active. A concurrent heartbeat prevents this operation, but releasing a genuinely active lock could allow overlapping processing.</p>
              <input v-model="dailyLockRecoveryToken" type="text" autocomplete="off" placeholder="RELEASE_STALE_DAILY_PIPELINE_LOCK" class="mt-3 w-full rounded border border-outline-variant/20 bg-surface-container px-2 py-1 text-[10px] text-on-surface" />
              <div class="mt-3 flex justify-end gap-2"><button @click="dailyLockRecoveryModalOpen = false" class="rounded-lg border border-outline-variant/20 px-3 py-1.5 text-xs text-on-surface-variant">Cancel</button><button @click="releaseDailyPipelineLock" :disabled="dailyLockRecoveryToken !== 'RELEASE_STALE_DAILY_PIPELINE_LOCK' || dailyLockRecoveryLoading" class="rounded-lg bg-rose-400/20 px-3 py-1.5 text-xs font-bold text-rose-100 disabled:opacity-50">{{ dailyLockRecoveryLoading ? 'Releasing...' : 'Confirm release' }}</button></div>
            </div>
          </div>
        </div>
        </section>

        <section
          v-if="showFullDevTools"
          class="rounded-2xl border border-violet-500/20 bg-violet-500/5 px-4 py-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="font-headline text-sm font-bold text-on-surface">Reliability diagnostics</h2>
              <p class="mt-1 text-xs text-on-surface-variant">Bounded notification, RSS ownership, redirect, and browser-runtime evidence. Query values and payload bodies are redacted.</p>
            </div>
            <button @click="loadReliabilityDiagnostics" :disabled="reliabilityDiagnosticsLoading" class="rounded-lg border border-violet-400/20 bg-violet-400/10 px-3 py-1.5 text-xs font-bold text-violet-100 disabled:opacity-60">{{ reliabilityDiagnosticsLoading ? 'Loading...' : 'Refresh' }}</button>
          </div>
          <p v-if="reliabilityDiagnosticsError" class="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">{{ reliabilityDiagnosticsError }}</p>
          <div v-else-if="reliabilityDiagnosticsLoaded" class="mt-3 space-y-3 text-[10px] text-on-surface-variant">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="rounded-lg bg-surface-container/70 px-3 py-2">
                <div class="font-bold uppercase tracking-wider text-violet-200">Notification workflow</div>
                <div v-if="reliabilityDiagnostics.notifications.markers.length === 0" class="mt-1">No marker for the current UTC date.</div>                  <div v-for="marker in reliabilityDiagnostics.notifications.markers.slice(0, 3)" :key="marker.id" class="mt-1 space-y-0.5">
                  <div class="flex flex-wrap items-center gap-2"><strong class="text-on-surface">{{ marker.dateKey || 'unknown date' }}</strong> · {{ marker.status }} · {{ marker.startState || 'unknown' }} <button v-if="marker.staleLaunching || marker.summary.reconciliationRequired" @click="reconciliationModalMarkerId = marker.id" :disabled="reconciliationLoading" class="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-100">{{ reconciliationLoading ? 'Saving...' : 'Acknowledge reconciliation' }}</button></div>
                  <div>run: {{ marker.workflowRunId || 'not persisted' }} · attempt: {{ marker.launchAttemptId || 'none' }} · external: {{ marker.externalWorkflow ? `${marker.externalWorkflow.exists ? 'known' : 'not found'}${marker.externalWorkflow.status ? ` / ${marker.externalWorkflow.status}` : ''}` : 'inconclusive' }}</div>
                  <div class="mt-2 space-y-1">
                    <div class="font-bold uppercase tracking-wider text-violet-200">Notification telemetry</div>
                    <div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <span>Recipient selection · matching slot: {{ marker.summary.usersMatchedSchedule ?? 'not recorded' }}</span>
                      <span>already notified: {{ marker.summary.usersAlreadyNotified ?? 'not recorded' }}</span>
                      <span>no active content scope: {{ marker.summary.usersWithoutActiveScope ?? 'not recorded' }}</span>
                      <span>empty eligible feed: {{ marker.summary.usersWithEmptyFeed ?? 'not recorded' }}</span>
                      <span>Inbox · notifications created: {{ marker.summary.inboxNotificationsCreated ?? 'not recorded' }}</span>
                      <span>inbox persistence failures: {{ marker.summary.inboxNotificationFailures ?? 'not recorded' }}</span>
                      <span>Browser push · users with active push: {{ marker.summary.usersWithActivePushSubscriptions ?? 'not recorded' }}</span>
                      <span>subscriptions attempted: {{ marker.summary.pushSubscriptionsAttempted ?? 'not recorded' }}</span>
                      <span>pushes delivered: {{ marker.summary.pushesDelivered ?? 'not recorded' }}</span>
                      <span>pushes failed: {{ marker.summary.pushesFailed ?? 'not recorded' }}</span>
                      <span>stale subscriptions deactivated: {{ marker.summary.stalePushSubscriptionsDeactivated ?? 'not recorded' }}</span>
                    </div>
                    <div v-if="marker.summary.usersMatchedSchedule === 0" class="font-bold text-amber-200">No users configured for this slot.</div>
                    <div v-else-if="marker.summary.inboxNotificationsCreated > 0 && marker.summary.usersWithActivePushSubscriptions === 0" class="font-bold text-cyan-200">Inbox notifications created, browser push unavailable.</div>
                    <div class="text-[9px] text-on-surface-variant">workflow: current {{ marker.summary.currentSlot || '—' }} → next {{ marker.summary.nextSlot || '—' }} · completed {{ (marker.summary.completedSlots || []).join(', ') || 'none' }} · legacy fields show “not recorded” when absent</div>
                  </div>
                  <div class="text-[9px] text-violet-200/80">retry-safe {{ marker.summary.retrySafe ? 'yes' : 'no' }} · first slot {{ marker.summary.firstSlotAttempted ? 'attempted' : 'not attempted' }} · delivered {{ marker.summary.deliveryStartedAt || '—' }} · completed {{ (marker.summary.completedSlots || []).join(', ') || 'none' }}</div>
                  <div v-if="marker.staleLaunching || marker.summary.reconciliationRequired" class="font-bold text-amber-200">Reconciliation required; automatic restart is disabled.</div>
                  <div v-if="marker.failureReason || marker.summary.lastError" class="text-rose-200">{{ marker.failureReason || marker.summary.lastError }}</div>
                </div>
              </div>
              <div class="rounded-lg bg-surface-container/70 px-3 py-2">
                <div class="font-bold uppercase tracking-wider text-cyan-200">RSS-owned / browser outcomes</div>
                <div class="mt-1">RSS skip/escalation reasons:</div>
                <div class="mt-1 flex flex-wrap gap-1"><span class="rounded bg-surface-container-highest px-1.5 py-0.5">productive skip: {{ reliabilityDiagnostics.rssOwnership.productiveSkip }}</span><span class="rounded bg-surface-container-highest px-1.5 py-0.5">waiting evidence: {{ reliabilityDiagnostics.rssOwnership.waitingForEvidenceSkip }}</span><span class="rounded bg-surface-container-highest px-1.5 py-0.5">invalid escalation: {{ reliabilityDiagnostics.rssOwnership.invalidFeedEscalation }}</span><span class="rounded bg-surface-container-highest px-1.5 py-0.5">scope mismatch: {{ reliabilityDiagnostics.rssOwnership.scopeMismatchEscalation }}</span></div>
                <div class="mt-2">Browser runtime statuses:</div>
                <div class="mt-1 flex flex-wrap gap-1"><span v-for="(value, key) in reliabilityDiagnostics.browserStatuses" :key="key" class="rounded bg-surface-container-highest px-1.5 py-0.5">{{ key }}: {{ value }}</span><span v-if="Object.keys(reliabilityDiagnostics.browserStatuses).length === 0">none</span></div>
                <div class="mt-2 text-cyan-200">Explicit admin bypass: targeted requests only; routine runs never bypass RSS ownership.</div>
              </div>
            </div>
            <div class="rounded-lg bg-surface-container/70 px-3 py-2">
              <div class="font-bold uppercase tracking-wider text-amber-200">Per-redirect retry state</div>
              <div v-if="reliabilityDiagnostics.redirects.length === 0" class="mt-1">No recent redirect retry artifacts.</div>
              <div v-for="redirect in reliabilityDiagnostics.redirects.slice(0, 5)" :key="redirect.id" class="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                <span class="truncate">{{ redirect.originalUrl || 'unknown URL' }}</span>
                <span>
                  <span :class="redirectStatusDescriptor(redirect).terminal ? 'text-rose-300' : redirectStatusDescriptor(redirect).resolved ? 'text-emerald-300' : 'text-on-surface-variant'">{{ redirectStatusDescriptor(redirect).label }}</span>
                  · attempts {{ redirect.attemptCount }}
                  <template v-if="redirectStatusDescriptor(redirect).terminal">
                    <span class="text-on-surface-variant/60">· no automatic retry</span>
                  </template>
                  <template v-else-if="redirectStatusDescriptor(redirect).retryable && redirectStatusDescriptor(redirect).nextRetryAt">
                    · next eligible {{ formatLogTime(redirectStatusDescriptor(redirect).nextRetryAt!) }}
                  </template>
                  <template v-else-if="redirectStatusDescriptor(redirect).retryable">
                    · next eligible soon
                  </template>
                </span>
              </div>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-on-surface-variant">Diagnostics not loaded yet.</p>
          <div v-if="reconciliationModalMarkerId" class="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
            <div class="w-full max-w-md rounded-2xl border border-amber-400/20 bg-surface-container-high p-4 shadow-2xl">
              <h3 class="font-headline text-sm font-bold text-on-surface">Close uncertain notification launch?</h3>
              <p class="mt-2 text-xs leading-relaxed text-on-surface-variant">This does not start or retry a workflow. Choose acknowledgement to keep it under review, or abandon it to close the marker permanently and prevent duplicate delivery.</p>
              <div class="mt-3 flex justify-end gap-2"><button @click="reconciliationModalMarkerId = null" class="rounded-lg border border-outline-variant/20 px-3 py-1.5 text-xs text-on-surface-variant">Cancel</button><button @click="reconcileNotificationMarker(reconciliationModalMarkerId, 'acknowledge'); reconciliationModalMarkerId = null" class="rounded-lg bg-amber-400/20 px-3 py-1.5 text-xs font-bold text-amber-100">Keep under review</button><button @click="reconcileNotificationMarker(reconciliationModalMarkerId, 'abandon'); reconciliationModalMarkerId = null" class="rounded-lg bg-rose-400/20 px-3 py-1.5 text-xs font-bold text-rose-100">Abandon / close</button></div>
            </div>
          </div>
          <div class="mt-3 rounded-lg border border-amber-400/15 bg-amber-500/5 px-3 py-2">
            <label class="block text-[9px] font-bold uppercase tracking-wider text-amber-200">Reconciliation confirmation token</label>
            <input v-model="reconciliationToken" type="text" autocomplete="off" placeholder="RECONCILE_NOTIFICATION_WORKFLOW_MARKER" class="mt-1 w-full rounded border border-outline-variant/20 bg-surface-container px-2 py-1 text-[10px] text-on-surface" />
            <p class="mt-1 text-[9px] text-on-surface-variant">Inspection is read-only. Acknowledgement only records that the uncertain external outcome requires review; it never starts a workflow.</p>
          </div>
        </section>

        <section
          v-if="showFullDevTools"
          class="rounded-2xl border border-rose-500/20 bg-rose-500/5 px-4 py-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div><h2 class="font-headline text-sm font-bold text-on-surface">Runtime-only hard-source repair</h2><p class="mt-1 text-xs text-on-surface-variant">Dry-run preview is the default. Writes require the exact confirmation token and only invalidate matching runtime/configuration-only profiles.</p></div>
            <div class="flex flex-wrap gap-2"><button @click="previewHardSourceRepair" :disabled="hardSourceRepairLoading" class="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-100">{{ hardSourceRepairLoading ? 'Loading...' : 'Preview dry-run' }}</button><button @click="hardSourceRepairModalOpen = true" :disabled="hardSourceRepairLoading || hardSourceRepairToken !== 'REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES'" class="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-1.5 text-xs font-bold text-rose-100 disabled:opacity-50">Confirm repair</button></div>
          </div>
          <input v-model="hardSourceRepairToken" type="text" autocomplete="off" placeholder="REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES" class="mt-2 w-full rounded border border-outline-variant/20 bg-surface-container px-2 py-1 text-[10px] text-on-surface" />
          <p v-if="hardSourceRepairError" class="mt-2 text-[10px] text-rose-200">{{ hardSourceRepairError }}</p><p v-if="hardSourceRepairResult" class="mt-2 text-[10px] text-emerald-200">{{ hardSourceRepairResult.dryRun ? 'Dry-run' : 'Repair' }}: scanned {{ hardSourceRepairResult.scanned }}, matched {{ hardSourceRepairResult.matched }}, updated {{ hardSourceRepairResult.updated }}.</p>
          <div v-if="hardSourceRepairModalOpen" class="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
            <div class="w-full max-w-md rounded-2xl border border-rose-400/20 bg-surface-container-high p-4 shadow-2xl">
              <h3 class="font-headline text-sm font-bold text-on-surface">Confirm runtime-only repair</h3>
              <p class="mt-2 text-xs leading-relaxed text-on-surface-variant">This guarded action writes only to profiles whose evidence is exclusively runtime/configuration failure. Profiles with genuine publisher evidence are preserved. The exact token is required.</p>
              <div class="mt-3 flex justify-end gap-2"><button @click="hardSourceRepairModalOpen = false" class="rounded-lg border border-outline-variant/20 px-3 py-1.5 text-xs text-on-surface-variant">Cancel</button><button @click="confirmHardSourceRepair(); hardSourceRepairModalOpen = false" class="rounded-lg bg-rose-400/20 px-3 py-1.5 text-xs font-bold text-rose-100">Confirm destructive repair</button></div>
            </div>
          </div>
        </section>

        <section
          class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4 space-y-5"
        >
        <div v-if="false && showFullDevTools">
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
                v-if="pipelineResetEnabled"
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

        <div v-if="false" class="flex flex-col gap-3 rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
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
              Manually trigger pipeline batches and queue maintenance. Agent 1 RSS ingest and Agent 2 web discovery run independently.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="canRunManualPipeline"
              @click="runManualPipeline"
              :disabled="isPipelineRunning || !canRunManualPipeline"
              class="rounded-lg bg-primary-container px-4 py-2 text-sm font-bold text-on-primary-container transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isPipelineRunning ? "Running..." : "Run Agent 1 batch" }}
            </button>
            <button
              @click="runArticleDiscovery"
              :disabled="isAgent2BatchDisabled"
              :title="agent2BatchDisabledReason || 'Run the next bounded Agent 2 discovery batch.'"
              class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isArticleDiscoveryRunning ? "Discovering..." : "Run Agent 2 batch" }}
            </button>
            <p v-if="agent2BatchDisabledReason" class="basis-full text-[11px] font-medium text-amber-200">
              Agent 2 batch unavailable: {{ agent2BatchDisabledReason }}
            </p>
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
              v-if="canRunManualPipeline"
              @click="runAgent3Enrichment"
              :disabled="isAgent3Running"
              class="rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-2 text-sm font-bold text-violet-100 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isAgent3Running ? "Extracting..." : "Run Agent 3 enrichment" }}
            </button>
            <!-- Agent 3 advanced controls -->
            <div v-if="canRunManualPipeline" class="flex flex-wrap items-center gap-3 text-[11px] text-on-surface-variant">
              <label class="flex items-center gap-1">
                <select v-model.number="agent3MaxArticles" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                  <option :value="10">10</option>
                  <option :value="25">25</option>
                  <option :value="50">50</option>
                </select>
                <span>max</span>
              </label>
              <label class="flex items-center gap-1 cursor-pointer">
                <input v-model="agent3IncludeEnriched" type="checkbox" class="accent-violet-400" />
                <span>include enriched</span>
              </label>
              <label class="flex items-center gap-1 cursor-pointer">
                <input v-model="agent3ForceReprocess" type="checkbox" class="accent-violet-400" />
                <span>force reprocess</span>
              </label>
              <span v-if="agent3IncludeEnriched || agent3ForceReprocess" class="text-amber-300 text-[10px]">⚠ reprocessing mode</span>
            </div>
            <!-- Phase 3: Browser fallback controls -->
            <div v-if="canRunManualPipeline" class="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-on-surface-variant">
              <label class="flex items-center gap-1 cursor-pointer">
                <input v-model="agent3BrowserFallback" type="checkbox" class="accent-sky-400" />
                <span class="font-medium">browser fallback</span>
              </label>
              <label v-if="agent3BrowserFallback" class="flex items-center gap-1">
                <select v-model.number="agent3BrowserFallbackMaxAttempts" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                  <option :value="1">1</option>
                  <option :value="3">3</option>
                  <option :value="5">5</option>
                  <option :value="10">10</option>
                </select>
                <span>max attempts</span>
              </label>
              <label v-if="agent3BrowserFallback" class="flex items-center gap-1">
                <select v-model.number="agent3BrowserTimeoutMs" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                  <option :value="15000">15s</option>
                  <option :value="25000">25s</option>
                  <option :value="35000">35s</option>
                </select>
              <span>timeout</span>
            </label>
            <label class="flex items-center gap-1">
              <select v-model.number="agent3MaxArticlesPerSource" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                <option :value="3">3</option>
                <option :value="5">5</option>
                <option :value="8">8</option>
                <option :value="10">10</option>
                <option :value="15">15</option>
              </select>
              <span>per source</span>
            </label>
          </div>
            <p v-if="agent3BrowserFallback" class="mt-1 w-full text-[10px] text-amber-300/80">
              ⚠ Browser fallback is slower and may hit site rate limits. Use small batches first.
            </p>
            <p class="mt-1 w-full text-[10px] text-on-surface-variant/60">
              Testing mode: reprocesses already enriched articles and only overwrites bodyText when the new extraction is materially better.
            </p>
          </div>
        </div>

        <details v-if="showFullDevTools" open class="rounded-2xl border border-outline-variant/20 bg-surface-container-high/60 px-4 py-3">
          <summary class="cursor-pointer select-none font-headline text-sm font-bold text-on-surface">
            Agent 1 - RSS ingest
          </summary>
          <div class="mt-3 rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-4 py-3">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 class="font-headline text-sm font-bold text-on-surface">Agent 1 controls</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Run the next bounded RSS ingest batch.</p>
              </div>
              <button
                v-if="canRunManualPipeline"
                @click="runManualPipeline"
                :disabled="isPipelineRunning || !canRunManualPipeline"
                class="rounded-lg bg-primary-container px-4 py-2 text-sm font-bold text-on-primary-container transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isPipelineRunning ? "Running..." : "Run Agent 1 batch" }}
              </button>
            </div>
          </div>

        <div class="mt-4 border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 1 RSS ingest summary
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Latest-run only: Agent 1 outcome and reviewed source/category results from the most recent Agent 1 pipeline run.
              </p>
            </div>
            <button
              @click="loadAgent1RunSummary"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              Refresh
            </button>
          </div>

          <div v-if="agent1Summary.latestRun" class="mt-3 rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                :class="agent1Summary.latestRun.failed > 0 ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'"
              >
                {{ agent1Summary.latestRun.failed > 0 ? "completed with failures" : "completed" }}
              </span>
              <span class="text-[10px] text-on-surface-variant">{{ formatLogTime(agent1Summary.latestRun.createdAt) }}</span>
              <span v-if="agent1Summary.latestRun.durationMs != null" class="text-[10px] text-on-surface-variant">
                duration: {{ Math.round(agent1Summary.latestRun.durationMs / 1000) }}s
              </span>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
              <span>targets: <strong>{{ agent1Summary.latestRun.targets }}</strong></span>
              <span>candidates: <strong>{{ agent1Summary.latestRun.candidates }}</strong></span>
              <span>inserted: <strong class="text-emerald-300">{{ agent1Summary.latestRun.inserted }}</strong></span>
              <span>skipped: <strong>{{ agent1Summary.latestRun.skipped }}</strong></span>
              <span>failed: <strong :class="agent1Summary.latestRun.failed > 0 ? 'text-rose-300' : 'text-emerald-300'">{{ agent1Summary.latestRun.failed }}</strong></span>
              <span>artifacts: <strong>{{ agent1Summary.latestRun.artifacts }}</strong></span>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-on-surface-variant">
            No recent Agent 1 pipeline finish log found.
          </p>

          <div v-if="agent1Summary.recentSourceOutcomes.length > 0" class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="item in agent1Summary.recentSourceOutcomes"
              :key="`${item.status}-${item.sourceId || item.createdAt}`"
              class="rounded-xl border px-3 py-2"
              :class="item.resultType === 'failed' ? 'border-rose-500/10 bg-rose-500/5' : item.resultType === 'rate_limited' ? 'border-amber-500/15 bg-amber-500/5' : 'border-emerald-500/10 bg-emerald-500/5'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                      :class="item.resultType === 'failed' ? 'bg-rose-500/15 text-rose-200' : item.resultType === 'rate_limited' ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'"
                    >
                      {{ item.resultType === 'pass' ? 'pass' : item.resultType === 'rss_active_no_new_articles' ? 'rss active / no new articles' : item.resultType === 'rate_limited' ? 'rate limited / deferred' : item.resultType === 'handoff' ? 'handoff' : 'failed' }}
                    </span>
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">{{ item.targetType }}</span>
                    <span v-if="item.sourceId" class="text-[10px] text-on-surface-variant">src: {{ item.sourceId.slice(0, 8) }}...</span>
                    <span class="text-[10px] text-on-surface-variant">{{ formatLogTime(item.createdAt) }}</span>
                  </div>
                  <div class="mt-1 space-y-0.5 text-[11px] text-on-surface">
                    <p class="truncate">
                      <span class="font-semibold text-on-surface-variant">Source Url:</span>
                      {{ item.sourceUrl || item.sourceId || "unknown target" }}
                    </p>
                    <p v-if="(item.passed || item.rssActive || item.rateLimited) && item.feedUrl" class="truncate">
                      <span class="font-semibold text-on-surface-variant">RSS Url:</span>
                      {{ item.rssUrl || item.feedUrl }}
                    </p>
                  </div>
                  <div v-if="item.passed" class="mt-1 flex flex-wrap gap-2 text-[10px] text-on-surface-variant">
                    <span>loaded articles: <strong class="text-emerald-300">{{ item.inserted }}</strong></span>
                    <span>candidates: <strong>{{ item.candidates }}</strong></span>
                    <span>skipped: <strong>{{ item.skipped }}</strong></span>
                    <span v-if="(item.urlPolicyRejected ?? 0) > 0" class="text-amber-300">non-article URL: <strong>{{ item.urlPolicyRejected }}</strong></span>
                  </div>
                  <p v-else class="mt-1 line-clamp-2 text-[10px]" :class="item.rateLimited ? 'text-amber-100/80' : 'text-rose-100/80'">
                    {{ item.failureReason }}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-on-surface-variant">
            No source-level Agent 1 outcomes found in recent logs.
          </p>
        </div>

        <!-- Agent 1 Progress panel -->
        <div
          v-if="showFullDevTools && (agent1Progress != null || agent1ProgressLoading)"
          class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 1 Progress
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Current Agent 1 eligibility and latest batch run state.
              </p>
            </div>
            <button
              @click="loadAgent1Progress"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              {{ agent1ProgressLoading ? 'Loading...' : 'Refresh' }}
            </button>
          </div>
          <div v-if="agent1Progress" class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-on-surface-variant">
            <span>Eligible now: <strong class="text-cyan-200">{{ agent1Progress.totalEligibleNow }}</strong></span>
            <span v-if="agent1Progress.processedLastRun > 0">Last run processed: <strong>{{ agent1Progress.processedLastRun }}</strong></span>
            <span>Latest batch deferred: <strong :class="agent1Progress.deferredLastRun > 0 ? 'text-amber-200' : 'text-emerald-300'">{{ agent1Progress.deferredLastRun }}</strong></span>
            <span v-if="agent1Progress.stoppedReason" class="font-medium text-amber-200">stopped: {{ agent1Progress.stoppedReason }}</span>
            <span v-if="agent1Progress.lastDurationMs != null">Duration: <strong>{{ Math.round(agent1Progress.lastDurationMs / 1000) }}s</strong></span>
          </div>
          <p v-if="agent1Progress && agent1Progress.remainingEligible === 0 && agent1Progress.lastRunAt" class="mt-2 text-xs text-emerald-300">
            The latest Agent 1 batch left no deferred targets. "Eligible now" is the current next-cycle scope.
          </p>
          <p v-else-if="agent1Progress && agent1Progress.remainingEligible > 0" class="mt-2 text-xs text-amber-200">
            More Agent 1 targets remain. Run Agent 1 again or wait for the next scheduled batch.
          </p>
          <div v-if="agent1Progress && agent1Progress.recentDeferredTargets.length > 0" class="mt-3">
            <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/70">
              Recent deferred targets ({{ agent1Progress.recentDeferredTargets.length }})
            </p>
            <div
              v-for="(dt, di) in agent1Progress.recentDeferredTargets.slice(0, 5)"
              :key="di"
              class="mt-1 flex flex-wrap gap-2 text-[10px] text-on-surface-variant"
            >
              <span class="truncate max-w-[200px]">{{ dt.sourceId }}{{ dt.categoryId ? '/' + dt.categoryId : '' }}</span>
              <span class="text-amber-200">{{ dt.reason }}</span>
            </div>
          </div>
        </div>
        </details>

        <!-- Agent 2 progress panel (page-load state) -->
        <details v-if="showFullDevTools" open class="rounded-2xl border border-outline-variant/20 bg-surface-container-high/60 px-4 py-3">
          <summary class="cursor-pointer select-none font-headline text-sm font-bold text-on-surface">
            Agent 2 - Discovery and headless queue
          </summary>
          <div class="mt-3 rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-4 py-3">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 class="font-headline text-sm font-bold text-on-surface">Agent 2 controls</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Run static discovery after Agent 1 batches are complete.</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  @click="runArticleDiscovery"
                  :disabled="isAgent2BatchDisabled"
                  :title="agent2BatchDisabledReason || 'Run the next bounded Agent 2 discovery batch.'"
                  class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {{ isArticleDiscoveryRunning ? "Discovering..." : "Run Agent 2 batch" }}
                </button>
                <button
                  v-if="canRunManualPipeline"
                  @click="runHardCaseQueue"
                  :disabled="isHardCaseQueueRunning"
                  class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {{ isHardCaseQueueRunning ? "Running..." : "Run hard-case queue" }}
                </button>
                <p v-if="agent2BatchDisabledReason" class="basis-full text-[11px] font-medium text-amber-200">
                  Agent 2 batch unavailable: {{ agent2BatchDisabledReason }}
                </p>
              </div>
            </div>
          </div>
        <div
          v-if="showFullDevTools && (agent2Progress != null || agent2ProgressLoading)"
          class="rounded-2xl border border-outline-variant/20 bg-surface-container-high px-5 py-4"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 2 Progress
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Current Agent 2 eligibility and latest batch run state.
              </p>
            </div>
            <button
              @click="loadAgent2Progress"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              {{ agent2ProgressLoading ? 'Loading...' : 'Refresh' }}
            </button>
          </div>
          <div v-if="agent2Progress" class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-on-surface-variant">
            <span>Eligible now: <strong class="text-cyan-200">{{ agent2Progress.totalEligibleNow }}</strong></span>
            <span v-if="agent2Progress.processedLastRun > 0">Last run processed: <strong>{{ agent2Progress.processedLastRun }}</strong></span>
            <span>Latest batch deferred: <strong :class="agent2Progress.deferredLastRun > 0 ? 'text-amber-200' : 'text-emerald-300'">{{ agent2Progress.deferredLastRun }}</strong></span>
            <span v-if="agent2Progress.stoppedReason" class="font-medium text-amber-200">stopped: {{ agent2Progress.stoppedReason }}</span>
            <span v-if="agent2Progress.lastDurationMs != null">Duration: <strong>{{ Math.round(agent2Progress.lastDurationMs / 1000) }}s</strong></span>
          </div>
          <p v-if="agent1Progress && agent1Progress.remainingEligible > 0" class="mt-2 text-xs text-amber-200">
            Blocked by Agent 1: {{ agent1Progress.remainingEligible }} remaining. Finish Agent 1 batches before running Agent 2.
          </p>
          <p v-else-if="agent2Progress && agent2Progress.totalEligibleNow === 0" class="mt-2 text-xs text-emerald-300">
            No Agent 2 targets currently eligible.
          </p>
          <p v-else-if="agent2Progress && agent2Progress.remainingEligible > 0 && agent2Progress.stoppedReason" class="mt-2 text-xs text-amber-200">
            More eligible targets remain. Run Agent 2 again or wait for the next scheduled batch.
          </p>
          <div v-if="agent2Progress && agent2Progress.recentDeferredTargets.length > 0" class="mt-3">
            <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/70">
              Recent deferred targets ({{ agent2Progress.recentDeferredTargets.length }})
            </p>
            <div
              v-for="(dt, di) in agent2Progress.recentDeferredTargets.slice(0, 5)"
              :key="di"
              class="mt-1 flex flex-wrap gap-2 text-[10px] text-on-surface-variant"
            >
              <span class="truncate max-w-[200px]">{{ dt.targetUrl }}</span>
              <span class="text-amber-200">{{ dt.reason }}</span>
            </div>
          </div>
        </div>
        <div class="mt-4 border-t border-outline-variant/20 pt-4">
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

          <!-- View filter controls -->
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <div class="flex rounded-lg border border-outline-variant/20 overflow-hidden">
              <button
                v-for="viewOption in headlessQueueViewOptions"
                :key="viewOption"
                @click="headlessQueueView = viewOption; loadHeadlessQueue()"
                class="px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors"
                :class="headlessQueueView === viewOption
                  ? 'bg-primary-container text-on-primary-container'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'"
              >
                {{ viewOption }}
              </button>
            </div>
            <span v-if="headlessQueueSummary" class="text-[10px] text-on-surface-variant">
              {{ headlessQueueSummary.activeTotal }} active
              <span v-if="headlessQueueSummary.historyTotal > 0" class="text-on-surface-variant/50">
                · {{ headlessQueueSummary.historyTotal }} history
              </span>
              <span v-if="headlessQueueSummary.retryableTotal > 0" class="text-amber-300">
                · {{ headlessQueueSummary.retryableTotal }} retryable
              </span>
              <span v-if="headlessQueueSummary.cooldownPendingTotal > 0" class="text-cyan-300">
                · {{ headlessQueueSummary.cooldownPendingTotal }} cooldown
              </span>
            </span>
          </div>

          <div v-if="headlessQueueSummary" class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="(count, status) in headlessQueueSummary.byStatus"
              :key="status"
              class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              :class="headlessStatusBadgeClass(status as string)"
            >
              {{ status }}: {{ count }}
              <span
                v-if="isLegacyHeadlessStatus(status as string)"
                class="ml-0.5 opacity-60"
              >legacy</span>
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
                      <span v-if="isLegacyHeadlessStatus(item.status)" class="ml-0.5 opacity-60">legacy</span>
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
                    <span v-if="item.lastBrowserAttemptAt">browser attempt: {{ formatLogTime(item.lastBrowserAttemptAt) }}</span>
                    <span v-if="item.lastBrowserFinishedAt">browser finished: {{ formatLogTime(item.lastBrowserFinishedAt) }}</span>
                    <span v-if="item.headlessRecoveryCount">recovered: {{ item.headlessRecoveryCount }}x</span>
                    <span v-if="item.lastHeadlessRecoveryAt">last recovery: {{ formatLogTime(item.lastHeadlessRecoveryAt) }}</span>
                  </div>
                  <div v-if="canRunManualPipeline && isRetryableHeadlessStatus(item.status)" class="mt-2">
                    <button
                      @click="retryHeadlessQueueItem(item)"
                      :disabled="retryingHeadlessArtifactId === item.id"
                      class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {{ retryingHeadlessArtifactId === item.id ? "Retrying..." : "Retry browser" }}
                    </button>
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
                      <span v-if="item.lastBrowserAttemptAt">last attempt: {{ formatLogTime(item.lastBrowserAttemptAt) }}</span>
                      <span v-if="item.lastBrowserFinishedAt">last finished: {{ formatLogTime(item.lastBrowserFinishedAt) }}</span>
                    </div>
                    <p v-if="item.browserError" class="mt-1 line-clamp-2 text-[10px] text-rose-300/80">
                      {{ item.browserError }}
                    </p>
                    <p v-else-if="item.browserQualityAssessment?.explanation" class="mt-1 line-clamp-2 text-[10px] text-on-surface-variant/60">
                      {{ item.browserQualityAssessment.explanation }}
                    </p>
                    <div v-if="item.browserRateLimited || item.browserBlockedReason === 'http_429'" class="mt-2 rounded-lg border border-rose-400/20 bg-rose-500/5 px-2.5 py-1.5 text-[10px] text-rose-100/90">
                      <div class="font-bold uppercase tracking-wider text-rose-200">Rate limited</div>
                      <div class="mt-0.5">
                        Browser detail fetches hit HTTP 429.
                        <span v-if="item.browserRetryAfterAt">Retry after {{ formatLogTime(item.browserRetryAfterAt) }}.</span>
                      </div>
                      <div v-if="item.browserRateLimitedCount != null && item.browserRateLimitedCount > 0" class="mt-0.5 text-on-surface-variant/60">
                        Consecutive 429 responses: {{ item.browserRateLimitedCount }}
                      </div>
                      <div v-if="item.browserDetailEvaluationStoppedReason" class="mt-0.5 text-on-surface-variant/60">
                        Detail evaluation stopped: {{ item.browserDetailEvaluationStoppedReason }}
                      </div>
                    </div>
                    <!-- Browser cooldown state (Approach A: stays PENDING_HEADLESS) -->
                    <div v-if="item.status === 'BROWSER_COOLDOWN_DEFERRED'" class="mt-2 rounded-lg border border-amber-400/20 bg-amber-500/5 px-2.5 py-1.5 text-[10px] text-amber-100/90">
                      <div class="font-bold uppercase tracking-wider text-amber-200">Cooldown deferred (legacy)</div>
                      <div class="mt-0.5">
                        Browser fallback skipped — previous run was rate-limited.
                        Retry manually or wait for stale recovery.
                      </div>
                    </div>
                    <!-- Active durable PENDING_HEADLESS cooldown -->
                    <div v-if="item.cooldownDeferred" class="mt-2 rounded-lg border border-cyan-400/20 bg-cyan-500/5 px-2.5 py-1.5 text-[10px] text-cyan-100/90">
                      <div class="font-bold uppercase tracking-wider text-cyan-200">In browser cooldown</div>
                      <div class="mt-0.5">
                        Browser skipped — previous run was rate-limited.
                        <span>Cooldown until: <strong>{{ formatLogTime(item.nextEligibleAt!) }}</strong></span>
                        <span> (retryable in <strong>{{ cooldownRemainingMinutes(item.nextEligibleAt) }} min</strong>)</span>
                      </div>
                      <div v-if="item.browserRateLimitReason" class="mt-0.5 text-on-surface-variant/60">
                        Reason: {{ item.browserRateLimitReason }}
                      </div>
                      <div v-if="item.lastBrowserCooldownSkipAt" class="mt-0.5 text-on-surface-variant/60">
                        Last skipped by queue: {{ formatLogTime(item.lastBrowserCooldownSkipAt) }}
                      </div>
                    </div>
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
                  <!-- Browser date anomaly samples (headless queue) -->
                  <div v-if="item.dateAnomalySamples && item.dateAnomalySamples.length > 0" class="mt-2 rounded-lg border border-rose-400/20 bg-rose-500/5 px-2.5 py-1.5">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-rose-200/85">
                      Browser date anomalies ({{ item.dateAnomalySamples.length }})
                    </p>
                    <div
                      v-for="(sample, si) in item.dateAnomalySamples.slice(0, 3)"
                      :key="`date-anomaly-${si}`"
                      class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                    >
                      <span class="font-medium text-rose-100">
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
                Bounded evidence for static/browser outcomes. Runtime-only failures remain repairable diagnostics, not publisher or AI-inspection evidence.
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
            <template v-if="hardSourceSummary.evidenceTargetCount === 0">
              No Agent 2 discovery evidence exists in the current reporting window.
            </template>
            <template v-else-if="hardSourceSummary.cooldownOnlyCount > 0">
              No target currently qualifies as a hard source. {{ hardSourceSummary.cooldownOnlyCount }} target(s) are under active 429 cooldown and {{ hardSourceSummary.resolvedOrProductiveCount }} are resolved or productive.
            </template>
            <template v-else>
              Evidence exists for {{ hardSourceSummary.evidenceTargetCount }} target(s), but none currently qualifies as a hard source. {{ hardSourceSummary.resolvedOrProductiveCount }} are resolved or productive.
            </template>
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

        <!-- Hard-source profiles panel -->
        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Hard-source profiles
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Persisted compact profiles for targets where static + browser discovery failed. Structured evidence for future AI inspection.
              </p>
            </div>
            <button
              @click="loadHardSourceProfiles"
              :disabled="hardSourceProfilesLoading"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ hardSourceProfilesLoading ? "Loading..." : "Refresh" }}
            </button>
          </div>

          <div v-if="hardSourceProfiles.length === 0 && !hardSourceProfilesLoading" class="mt-3 text-xs text-on-surface-variant">
            <template v-if="hardSourceSummary.qualifyingHardSourceCount > 0">
              {{ hardSourceSummary.qualifyingHardSourceCount }} qualifying hard-source target(s) exist, but their profiles have not been generated yet.
            </template>
            <template v-else-if="hardSourceSummary.evidenceTargetCount === 0">
              No profiles exist because there is no Agent 2 discovery evidence in the current reporting window.
            </template>
            <template v-else-if="hardSourceSummary.cooldownOnlyCount > 0">
              No profiles exist for temporary failures. {{ hardSourceSummary.cooldownOnlyCount }} target(s) are under active 429 cooldown.
            </template>
            <template v-else>
              No profiles are required: current evidence is resolved, productive, or otherwise non-qualifying.
            </template>
          </div>
          <div v-else-if="hardSourceProfilesLoading" class="mt-3 text-xs text-on-surface-variant">
            Loading profiles...
          </div>
          <div v-else class="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="profile in hardSourceProfiles"
              :key="profile.id"
              class="rounded-xl border px-3 py-2"
              :class="profile.suggestedNextAction === 'ai_profile_inspection'
                ? 'border-fuchsia-500/20 bg-fuchsia-500/5'
                : profile.profileConfidence === 'high'
                  ? 'border-rose-500/15 bg-rose-500/5'
                  : 'border-outline-variant/20 bg-surface-container'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="hardSourceActionBadgeClass(profile.suggestedNextAction || 'manual_review')"
                    >
                      {{ hardSourceActionLabel(profile.suggestedNextAction || 'manual_review') }}
                    </span>
                    <span v-if="profile.profileConfidence" class="text-[10px] font-medium" :class="profile.profileConfidence === 'high' ? 'text-rose-300' : profile.profileConfidence === 'medium' ? 'text-amber-300' : 'text-on-surface-variant/60'">
                      {{ profile.profileConfidence }} confidence
                    </span>
                    <span v-if="profile.failureCount > 1" class="text-[10px] font-medium text-rose-300">
                      {{ profile.failureCount }}x failed
                    </span>
                    <span v-if="(profile.evidenceCount ?? 1) > 1" class="text-[10px] font-medium text-on-surface-variant/70" title="One current row per logical target; older evidence kept in bounded history.">
                      {{ profile.evidenceCount }} evidence · {{ (profile.history || []).length }} history
                    </span>
                    <span
                      class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="hardSourceLifecycleBadgeClass(profile.lifecycleState || 'open')"
                    >
                      {{ profile.lifecycleState || "open" }}
                    </span>
                  </div>
                  <p class="mt-1 truncate text-[11px] text-on-surface-variant">
                    {{ profile.targetUrl || "no target url" }}
                  </p>
                  <div class="mt-0.5 flex flex-wrap gap-2 text-[10px] text-on-surface-variant/60">
                    <span v-if="profile.staticQuality">static: {{ profile.staticQuality }}</span>
                    <span v-if="profile.browserStatus">browser: {{ profile.browserStatus }}</span>
                    <span v-if="profile.lastAcceptedCount != null">accepted: {{ profile.lastAcceptedCount }}</span>
                    <span v-if="profile.lastInsertedCount != null">inserted: {{ profile.lastInsertedCount }}</span>
                    <span v-if="profile.sourceId">src: {{ profile.sourceId.slice(0, 8) }}...</span>
                    <span v-if="profile.categoryId">cat: {{ profile.categoryId.slice(0, 8) }}...</span>
                  </div>
                  <div v-if="profile.dominantReasons.length > 0" class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="reason in profile.dominantReasons.slice(0, 4)"
                      :key="reason"
                      class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                    >
                      {{ reason }}
                    </span>
                  </div>
                  <div v-if="profile.recoverySuggestion" class="mt-1 text-[10px] font-medium text-cyan-200">
                    recovery: {{ hardSourceActionLabel(profile.recoverySuggestion) }}
                  </div>
                  <!-- Applied profile metadata -->
                  <div v-if="profile.lifecycleState === 'applied'" class="mt-1 rounded border border-blue-500/15 bg-blue-500/5 px-2 py-1 text-[10px] text-blue-200">
                    <span>profile applied</span>
                    <span v-if="profile.updatedAt"> · {{ formatLogTime(profile.updatedAt) }}</span>
                  </div>
                  <!-- Resolved metadata -->
                  <div v-if="profile.resolvedAt || profile.resolvedReason" class="mt-1 rounded border border-emerald-500/15 bg-emerald-500/5 px-2 py-1 text-[10px] text-emerald-200">
                    <span v-if="profile.resolvedBy">resolved by {{ profile.resolvedBy }}</span>
                    <span v-if="profile.resolvedReason"> · {{ profile.resolvedReason }}</span>
                    <span v-if="profile.resolvedAt"> · {{ formatLogTime(profile.resolvedAt) }}</span>
                  </div>
                  <!-- Activation buttons for open/suggested profiles -->
                  <div v-if="profile.lifecycleState === 'open' || profile.lifecycleState === 'suggested'" class="mt-2 flex flex-wrap gap-1.5">
                    <button
                      @click="activateDiscoveryProfile(profile.id, 'draft')"
                      :disabled="activatingProfileId === profile.id"
                      class="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {{ activatingProfileId === profile.id ? 'Creating...' : 'Create draft profile' }}
                    </button>
                    <button
                      @click="activateDiscoveryProfile(profile.id, 'active')"
                      :disabled="activatingProfileId === profile.id"
                      class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {{ activatingProfileId === profile.id ? 'Activating...' : 'Activate profile' }}
                    </button>
                  </div>
                  <div v-if="activatingProfileError && activatingProfileTargetId === profile.id" class="mt-1 text-[10px] font-medium text-rose-300">
                    {{ activatingProfileError }}
                  </div>
                  <div v-if="profile.lastFailureAt" class="mt-0.5 text-[10px] text-on-surface-variant/50">
                    last failure: {{ formatLogTime(profile.lastFailureAt) }}
                  </div>
                </div>
                <div class="shrink-0 text-right text-[10px] text-on-surface-variant">
                  <div>{{ formatLogTime(profile.updatedAt) }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Agent 2 Health panel -->
        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 2 Health
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Per-target health scores sorted by worst first. Identifies sources needing attention without reading every log.
              </p>
            </div>
            <button
              @click="loadAgent2Health"
              :disabled="agent2HealthLoading"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ agent2HealthLoading ? "Loading..." : "Refresh" }}
            </button>
          </div>

          <div v-if="agent2HealthTargets.length === 0 && !agent2HealthLoading" class="mt-3 text-xs text-on-surface-variant">
            No Agent 2 health data yet. Health scores are computed from recent discovery artifacts.
          </div>
          <div v-else-if="agent2HealthLoading" class="mt-3 text-xs text-on-surface-variant">
            Loading health scores...
          </div>
          <div v-else class="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="target in agent2HealthTargets"
              :key="`${target.sourceId}-${target.categoryId ?? ''}-${target.targetUrl}`"
              class="rounded-xl border px-3 py-2"
              :class="target.health === 'healthy'
                ? 'border-emerald-500/15 bg-emerald-500/5'
                : target.health === 'weak'
                  ? 'border-amber-500/15 bg-amber-500/5'
                  : target.health === 'blocked'
                    ? 'border-rose-500/15 bg-rose-500/5'
                    : target.health === 'unsupported'
                      ? 'border-rose-500/25 bg-rose-500/10'
                      : 'border-outline-variant/20 bg-surface-container'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      :class="target.health === 'healthy'
                        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                        : target.health === 'weak'
                          ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                          : target.health === 'blocked'
                            ? 'border-rose-500/30 bg-rose-500/15 text-rose-300'
                            : target.health === 'unsupported'
                              ? 'border-rose-500/40 bg-rose-500/20 text-rose-200'
                              : 'border-outline-variant/30 bg-surface-container-highest text-on-surface-variant'"
                    >
                      {{ target.health }}
                    </span>
                    <span class="text-[10px] font-mono" :class="target.score >= 70 ? 'text-emerald-300' : target.score >= 40 ? 'text-amber-300' : 'text-rose-300'">
                      {{ target.score }}
                    </span>
                    <span class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant">
                      {{ target.currentLifecycleState }}
                    </span>
                    <span v-if="target.consecutiveFailures > 0" class="text-[10px] font-medium text-rose-300">
                      {{ target.consecutiveFailures }}x failed
                    </span>
                  </div>
                  <p class="mt-1 truncate text-[11px] text-on-surface-variant">
                    {{ target.targetUrl }}
                  </p>
                  <div class="mt-0.5 flex flex-wrap gap-2 text-[10px] text-on-surface-variant/60">
                    <span v-if="target.sourceId">src: {{ target.sourceId.slice(0, 8) }}...</span>
                    <span v-if="target.categoryId">cat: {{ target.categoryId.slice(0, 8) }}...</span>
                    <span v-if="target.lastStaticStatus">static: {{ target.lastStaticStatus }}</span>
                    <span v-if="target.lastBrowserStatus">browser: {{ target.lastBrowserStatus }}</span>
                    <span v-if="target.lastBrowserAttemptAt">browser attempt: {{ formatLogTime(target.lastBrowserAttemptAt) }}</span>
                    <span v-if="target.lastBrowserFinishedAt">browser finished: {{ formatLogTime(target.lastBrowserFinishedAt) }}</span>
                    <span v-if="target.lastProductiveAt">last good: {{ formatLogTime(target.lastProductiveAt) }}</span>
                    <span v-if="target.lastFailureAt">last fail: {{ formatLogTime(target.lastFailureAt) }}</span>
                  </div>
                  <p v-if="target.recommendedAction" class="mt-1 text-[10px] font-medium text-amber-200">
                    {{ target.recommendedAction }}
                  </p>
                  <!-- Cooldown observability: explicit active vs historical -->
                  <div
                    v-if="target.cooldownActive || target.lastHistoricalCooldownAt"
                    class="mt-1.5 rounded-lg border px-2.5 py-1.5"
                    :class="target.cooldownActive
                      ? 'border-cyan-500/15 bg-cyan-500/5'
                      : 'border-outline-variant/20 bg-surface-container'"
                  >
                    <p
                      class="text-[9px] font-bold uppercase tracking-wider"
                      :class="target.cooldownActive ? 'text-cyan-300/80' : 'text-on-surface-variant/60'"
                    >
                      {{ target.cooldownActive ? 'Active cooldown' : 'Historical cooldown' }}
                    </p>
                    <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-on-surface-variant/80">
                      <span v-if="target.cooldownActive && target.retryAfter">
                        Retry after: <strong>{{ formatLogTime(target.retryAfter) }}</strong>
                      </span>
                      <span v-if="target.cooldownActive && cooldownRemainingMinutes(target.retryAfter) != null" class="text-cyan-200">
                        Retryable in: <strong>{{ cooldownRemainingMinutes(target.retryAfter) }} min</strong>
                      </span>
                      <span v-if="target.cooldownActive && target.cooldownStartedAt">Started: {{ formatLogTime(target.cooldownStartedAt) }}</span>
                      <span v-if="target.cooldownActive && target.cooldownReason">Reason: <strong class="text-rose-200">{{ target.cooldownReason }}</strong></span>
                      <span v-if="target.lastHistoricalCooldownAt">Last cooldown: {{ formatLogTime(target.lastHistoricalCooldownAt) }} (expired)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        </details>

        <details v-if="showFullDevTools" open class="rounded-2xl border border-violet-500/20 bg-surface-container-high/60 px-4 py-3">
          <summary class="cursor-pointer select-none font-headline text-sm font-bold text-on-surface">
            Agent 3 - Article content extraction
          </summary>
          <div class="mt-3 rounded-xl border border-violet-500/15 bg-violet-500/5 px-4 py-3">
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 class="font-headline text-sm font-bold text-on-surface">Agent 3 controls</h3>
                  <p class="mt-1 text-xs text-on-surface-variant">Extract article body text and enrichment fields for Agent 2 articles.</p>
                </div>
                <button
                  v-if="canRunManualPipeline"
                  @click="runAgent3Enrichment"
                  :disabled="isAgent3Running"
                  class="rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-2 text-sm font-bold text-violet-100 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {{ isAgent3Running ? "Extracting..." : "Run Agent 3 enrichment" }}
                </button>
              </div>
              <div v-if="canRunManualPipeline" class="flex flex-wrap items-center gap-3 text-[11px] text-on-surface-variant">
                <label class="flex items-center gap-1">
                  <select v-model.number="agent3MaxArticles" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                    <option :value="10">10</option>
                    <option :value="25">25</option>
                    <option :value="50">50</option>
                  </select>
                  <span>max</span>
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input v-model="agent3IncludeEnriched" type="checkbox" class="accent-violet-400" />
                  <span>include enriched</span>
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input v-model="agent3ForceReprocess" type="checkbox" class="accent-violet-400" />
                  <span>force reprocess</span>
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input v-model="agent3BrowserFallback" type="checkbox" class="accent-sky-400" />
                  <span class="font-medium">browser fallback</span>
                </label>
                <label v-if="agent3BrowserFallback" class="flex items-center gap-1">
                  <select v-model.number="agent3BrowserFallbackMaxAttempts" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                    <option :value="1">1</option>
                    <option :value="3">3</option>
                    <option :value="5">5</option>
                    <option :value="10">10</option>
                  </select>
                  <span>max attempts</span>
                </label>
                <label v-if="agent3BrowserFallback" class="flex items-center gap-1">
                  <select v-model.number="agent3BrowserTimeoutMs" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                    <option :value="15000">15s</option>
                    <option :value="25000">25s</option>
                    <option :value="35000">35s</option>
                  </select>
                  <span>timeout</span>
                </label>
                <label class="flex items-center gap-1">
                  <select v-model.number="agent3MaxArticlesPerSource" class="rounded border border-outline-variant/30 bg-surface-container px-1.5 py-0.5 text-[11px]">
                    <option :value="3">3</option>
                    <option :value="5">5</option>
                    <option :value="8">8</option>
                    <option :value="10">10</option>
                    <option :value="15">15</option>
                  </select>
                  <span>per source</span>
                </label>
              </div>
              <p class="text-[10px] text-on-surface-variant/60">
                Testing mode can include already enriched articles and only overwrites bodyText when the new extraction is materially better.
              </p>
            </div>
          </div>

        <!-- Agent 3 Enrichment Summary panel -->
        <div
          v-if="showFullDevTools && agent3Summary"
          class="rounded-2xl border border-violet-500/20 bg-surface-container-high px-5 py-4"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 3 Enrichment Summary
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Latest Agent 3 article content extraction run result.
              </p>
            </div>
          </div>
          <div class="mt-3 rounded-xl border border-violet-500/15 bg-surface-container px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                :class="(agent3Summary.systemPersistFailed ?? 0) > 0 ? 'bg-rose-500/15 text-rose-200' : (agent3Summary.rejected ?? 0) > 0 ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'"
              >
                {{ (agent3Summary.systemPersistFailed ?? 0) > 0 ? 'completed with system failures' : (agent3Summary.rejected ?? 0) > 0 ? 'completed with extraction rejections' : 'completed' }}
              </span>
              <span v-if="agent3Summary.pipelineRunId" class="text-[10px] text-on-surface-variant">
                run: {{ agent3Summary.pipelineRunId.slice(0, 8) }}...
              </span>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
              <span>processed: <strong>{{ agent3Summary.articleCount }}</strong></span>
              <span>enriched: <strong class="text-emerald-300">{{ agent3Summary.successfullyEnriched ?? agent3Summary.byKind?.SUCCESS ?? 0 }}</strong></span>
              <span>rejected: <strong :class="(agent3Summary.rejected ?? agent3Summary.failed) > 0 ? 'text-rose-300' : 'text-emerald-300'">{{ agent3Summary.rejected ?? agent3Summary.failed }}</strong></span>
              <span>persisted: <strong>{{ agent3Summary.persistedOutcomes ?? agent3Summary.persisted }}</strong></span>
              <span v-if="(agent3Summary.systemPersistFailed ?? 0) > 0" class="text-rose-300">sys-fail: <strong>{{ agent3Summary.systemPersistFailed }}</strong></span>
              <span>artifacts: <strong>{{ agent3Summary.artifactCount }}</strong></span>
            </div>
            <div v-if="agent3Summary.sourceCooldowns && agent3Summary.sourceCooldowns.length > 0" class="mt-2 rounded-lg border border-rose-500/15 bg-rose-500/5 px-2.5 py-1.5">
              <p class="text-[10px] font-bold uppercase tracking-wider text-rose-300 mb-1">Source Cooldowns</p>
              <div class="space-y-1">
                <div v-for="cd in agent3Summary.sourceCooldowns" :key="cd.sourceId" class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-on-surface-variant">
                  <span class="font-bold text-rose-200">{{ cd.hostname }}</span>
                  <span>reason: <strong>{{ cd.reason }}</strong></span>
                  <span>failures: <strong>{{ cd.failureCount }}</strong></span>
                  <span>skipped: <strong>{{ cd.skippedInRun }}</strong></span>
                </div>
              </div>
            </div>
            <div v-if="agent3Summary.browserFallbackStats && agent3Summary.browserFallbackStats.attempted > 0" class="mt-2 rounded-lg border border-sky-500/15 bg-sky-500/5 px-2.5 py-1.5">
              <p class="text-[10px] font-bold uppercase tracking-wider text-sky-300 mb-1">Browser Fallback</p>
              <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-on-surface-variant">
                <span>attempted: <strong>{{ agent3Summary.browserFallbackStats.attempted }}</strong></span>
                <span>succeeded: <strong class="text-emerald-300">{{ agent3Summary.browserFallbackStats.succeeded }}</strong></span>
                <span>failed: <strong :class="agent3Summary.browserFallbackStats.failed > 0 ? 'text-rose-300' : ''">{{ agent3Summary.browserFallbackStats.failed }}</strong></span>
                <span v-if="agent3Summary.browserFallbackStats.runtimeUnavailable > 0" class="text-amber-300">runtime unavailable: <strong>{{ agent3Summary.browserFallbackStats.runtimeUnavailable }}</strong></span>
                <span v-if="agent3Summary.browserFallbackStats.rateLimited > 0" class="text-amber-300">rate limited: <strong>{{ agent3Summary.browserFallbackStats.rateLimited }}</strong></span>
              </div>
            </div>
            <div v-if="agent3Summary.byKind && Object.keys(agent3Summary.byKind).length > 0" class="mt-2 flex flex-wrap gap-1.5">
              <span
                v-for="(count, kind) in agent3Summary.byKind"
                :key="kind"
                class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                :class="kind === 'SUCCESS' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                  : kind === 'SKIPPED' ? 'border-outline-variant/20 bg-surface-container text-on-surface-variant'
                  : 'border-rose-500/20 bg-rose-500/10 text-rose-200'"
              >
                {{ kind }}: {{ count }}
              </span>
            </div>
          </div>
        </div>
        <div
          v-else-if="showFullDevTools && !agent3Summary"
          class="rounded-2xl border border-outline-variant/10 bg-surface-container-high/50 px-5 py-3"
        >
          <p class="text-xs text-on-surface-variant/60">
            No Agent 3 enrichment run in this admin session yet.
          </p>
        </div>

        <!-- Agent 3 Progress panel -->
        <div
          v-if="showFullDevTools && (agent3Progress != null || agent3ProgressLoading)"
          class="rounded-2xl border border-outline-variant/10 bg-surface-container-high/50 px-5 py-3 mt-2"
        >
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-bold text-on-surface-variant">Agent 3 Progress</h4>
            <button
              @click="loadAgent3Progress"
              class="rounded border border-outline-variant/20 bg-surface-container px-2 py-0.5 text-[10px] font-bold text-on-surface-variant transition-colors hover:text-on-surface"
            >
              {{ agent3ProgressLoading ? 'Loading...' : 'Refresh' }}
            </button>
          </div>
          <div v-if="agent3Progress" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
            <span>Total in scope: <strong>{{ agent3Progress.totalInScope }}</strong></span>
            <span>Policy eligible: <strong class="text-violet-300">{{ agent3Progress.eligibleNow }}</strong></span>
            <span>Retryable now: <strong class="text-emerald-300">{{ agent3Progress.retryableNow ?? agent3Progress.eligibleNow }}</strong></span>
            <span v-if="(agent3Progress.recentlyBlocked ?? 0) > 0" class="text-amber-300">Recently blocked: <strong>{{ agent3Progress.recentlyBlocked }}</strong></span>
            <span v-if="(agent3Progress.nonRetryableCurrentVersionFailures ?? 0) > 0" class="text-rose-300/80">Non-retryable failures: <strong>{{ agent3Progress.nonRetryableCurrentVersionFailures }}</strong></span>
            <span>Needs initial enrichment: <strong>{{ agent3Progress.needingInitialEnrichment }}</strong></span>
            <span>Needs extractor reprocess: <strong class="text-amber-300">{{ agent3Progress.needsCurrentVersionReprocess }}</strong></span>
            <span>Current version complete: <strong class="text-emerald-300">{{ agent3Progress.currentVersionComplete }}</strong></span>
            <span v-if="(agent3Progress.deferred ?? 0) > 0" class="text-amber-200">Deferred: <strong>{{ agent3Progress.deferred }}</strong></span>
          </div>
          <p v-if="(agent3Progress?.nonRetryableCurrentVersionFailures ?? 0) > 0" class="mt-1 text-[10px] text-on-surface-variant/60">
            Non-retryable failures were already attempted with the current extractor and will not be retried until force reprocess or extractor version changes.
          </p>
          <p v-if="agent3Progress?.progressTruncated" class="mt-1 text-[10px] text-amber-300">
            ⚠ Progress count reached the safety scan limit ({{ agent3Progress.progressScanned }} scanned); remaining count may be higher.
          </p>
          <p v-else-if="agent3Progress?.selectedMode.includeEnriched" class="mt-1 text-[10px] text-amber-300/80">
            Reprocess scope includes articles with stale extractor version or missing body text.
          </p>
          <div v-if="agent3Progress?.latestRun" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
            <span>Last run processed: <strong>{{ agent3Progress.latestRun.processed }}</strong></span>
            <span>Enriched: <strong class="text-emerald-300">{{ agent3Progress.latestRun.successfullyEnriched }}</strong></span>
            <span>Rejected: <strong :class="agent3Progress.latestRun.rejected > 0 ? 'text-rose-300' : 'text-emerald-300'">{{ agent3Progress.latestRun.rejected }}</strong></span>
            <span v-if="agent3Progress.latestRun.durationMs != null">Duration: <strong>{{ Math.round(agent3Progress.latestRun.durationMs / 1000) }}s</strong></span>
          </div>
          <div v-if="agent3Progress?.latestRun?.browserFallbackStats && agent3Progress.latestRun.browserFallbackStats.attempted > 0" class="mt-1.5 rounded-lg border border-sky-500/15 bg-sky-500/5 px-2.5 py-1.5">
            <p class="text-[10px] font-bold text-sky-300/80 mb-0.5">Browser fallback (persisted)</p>
            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-on-surface-variant">
              <span>attempted: <strong>{{ agent3Progress.latestRun.browserFallbackStats.attempted }}</strong></span>
              <span>succeeded: <strong class="text-emerald-300">{{ agent3Progress.latestRun.browserFallbackStats.succeeded }}</strong></span>
              <span>failed: <strong :class="agent3Progress.latestRun.browserFallbackStats.failed > 0 ? 'text-rose-300' : ''">{{ agent3Progress.latestRun.browserFallbackStats.failed }}</strong></span>
              <span v-if="agent3Progress.latestRun.browserFallbackStats.runtimeUnavailable > 0" class="text-amber-300">runtime unavail: <strong>{{ agent3Progress.latestRun.browserFallbackStats.runtimeUnavailable }}</strong></span>
              <span v-if="agent3Progress.latestRun.browserFallbackStats.rateLimited > 0" class="text-amber-300">rate limited: <strong>{{ agent3Progress.latestRun.browserFallbackStats.rateLimited }}</strong></span>
              <span v-if="agent3Progress.latestRun.browserFallbackStats.stoppedReason" class="text-amber-300">stopped: {{ agent3Progress.latestRun.browserFallbackStats.stoppedReason }}</span>
            </div>
          </div>
          <p v-if="(agent3Progress?.recentlyBlocked ?? 0) > 0" class="mt-1 text-[10px] text-amber-300">
            ⚠ Some failed articles are cooling down because the publisher returned 403/429 or browser fallback is temporarily unavailable.
          </p>
          <div v-if="agent3Progress?.latestRun?.sourceCooldowns && agent3Progress.latestRun.sourceCooldowns.length > 0" class="mt-2 rounded-lg border border-rose-500/15 bg-rose-500/5 px-2.5 py-1.5">
            <p class="text-[10px] font-bold uppercase tracking-wider text-rose-300 mb-1">Source Cooldowns (persisted)</p>
            <div class="space-y-0.5">
              <div v-for="cd in agent3Progress.latestRun.sourceCooldowns" :key="cd.sourceId" class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-on-surface-variant">
                <span class="font-bold text-rose-200">{{ cd.hostname }}</span>
                <span>reason: <strong>{{ cd.reason }}</strong></span>
                <span>failures: <strong>{{ cd.failureCount }}</strong></span>
                <span>skipped: <strong>{{ cd.skippedInRun }}</strong></span>
              </div>
            </div>
          </div>
          <p v-if="agent3Progress && (agent3Progress.retryableNow ?? 0) > 0" class="mt-2 text-xs text-amber-200">
            More Agent 3 articles remain for the current extractor version. Run Agent 3 again.
          </p>
          <p v-else-if="agent3Progress && (agent3Progress.deferred ?? 0) > 0" class="mt-2 text-xs text-amber-200">
            No Agent 3 work is ready now. Deferred articles become eligible after publisher cooldowns expire<span v-if="agent3Progress.nextRetryAt"> (next retry: {{ formatRetryDateTime(agent3Progress.nextRetryAt) }})</span>.
          </p>
          <p v-else-if="agent3Progress" class="mt-2 text-xs text-emerald-300">
            No retryable Agent 3 articles remain for the selected mode.
          </p>
        </div>

        <!-- Agent 3 Rejection Diagnostics panel -->
        <div
          v-if="showFullDevTools"
          class="rounded-2xl border border-rose-500/20 bg-surface-container-high px-5 py-4 mt-2"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Agent 3 rejection diagnostics
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Recent rejected article extraction outcomes from Agent 3.
              </p>
            </div>
            <button
              @click="loadAgent3RejectionDiagnostics"
              :disabled="agent3RejectionLoading"
              class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ agent3RejectionLoading ? 'Loading...' : 'Refresh' }}
            </button>
          </div>

          <!-- Kind filter buttons -->
          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              v-for="mode in ['latest_run', 'recent_unique']"
              :key="mode"
              @click="agent3RejectionScope = mode; loadAgent3RejectionDiagnostics()"
              class="rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors"
              :class="agent3RejectionScope === mode
                ? 'border-violet-500/30 bg-violet-500/15 text-violet-200'
                : 'border-outline-variant/20 bg-surface-container text-on-surface-variant hover:text-on-surface'"
            >
              {{ mode === 'latest_run' ? 'Latest run' : 'Recent unique' }}
            </button>
            <button
              v-for="k in ['all', ...agent3RejectionKinds]"
              :key="k"
              @click="agent3RejectionFilter = k; loadAgent3RejectionDiagnostics()"
              class="rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors"
              :class="agent3RejectionFilter === k
                ? (k === 'HTTP_ACCESS_BLOCKED' || k === 'HEADLESS_REQUIRED' ? 'border-amber-500/30 bg-amber-500/15 text-amber-200' : k === 'INTERSTITIAL_OR_CHALLENGE' ? 'border-sky-500/30 bg-sky-500/15 text-sky-200' : 'border-rose-500/30 bg-rose-500/15 text-rose-200')
                : 'border-outline-variant/20 bg-surface-container text-on-surface-variant hover:text-on-surface'"
            >
              {{ k === 'all' ? 'ALL' : k }}
            </button>
          </div>

          <!-- Summary badges -->
          <div v-if="agent3RejectionData" class="mt-2 flex flex-wrap gap-1.5">
            <span
              class="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-200"
            >
              total: {{ agent3RejectionData.summary.totalReturned }}
            </span>
            <span
              v-for="(count, kind) in agent3RejectionData.summary.byKind"
              :key="kind"
              class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              :class="kind === 'HEADLESS_REQUIRED' || kind === 'HTTP_ACCESS_BLOCKED' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : kind === 'INTERSTITIAL_OR_CHALLENGE' ? 'border-sky-500/20 bg-sky-500/10 text-sky-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200'"
            >
              {{ kind }}: {{ count }}
            </span>
            <span
              v-if="agent3RejectionData.summary.httpAccessBlocked"
              class="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-200"
            >
              HTTP access blocked: {{ agent3RejectionData.summary.httpAccessBlocked }}
            </span>
            <span
              class="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-200"
            >
              {{ agent3RejectionScope === 'latest_run' ? 'latest run only' : 'recent unique articles' }}
            </span>
          </div>

          <div v-if="!agent3RejectionData && !agent3RejectionLoading" class="mt-3 text-xs text-on-surface-variant/60">
            Click Refresh to load rejection diagnostics.
          </div>
          <div v-else-if="agent3RejectionLoading" class="mt-3 text-xs text-on-surface-variant">
            Loading rejection diagnostics...
          </div>
          <div v-else-if="agent3RejectionData && agent3RejectionData.items.length === 0" class="mt-3 text-xs text-on-surface-variant">
            No rejection diagnostics found.
          </div>
          <div v-else-if="agent3RejectionData" class="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="item in agent3RejectionData.items"
              :key="item.id"
              class="rounded-xl border px-3 py-2"
              :class="item.kind === 'HEADLESS_REQUIRED' || item.kind === 'HTTP_ACCESS_BLOCKED' ? 'border-amber-500/15 bg-amber-500/5' : item.kind === 'INTERSTITIAL_OR_CHALLENGE' ? 'border-sky-500/15 bg-sky-500/5' : 'border-rose-500/10 bg-rose-500/5'"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                      :class="item.kind === 'HEADLESS_REQUIRED' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                        : item.kind === 'HTTP_ACCESS_BLOCKED' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                        : item.kind === 'INTERSTITIAL_OR_CHALLENGE' ? 'border-sky-500/20 bg-sky-500/10 text-sky-200'
                        : item.kind === 'LOW_CONTENT_QUALITY' ? 'border-orange-500/20 bg-orange-500/10 text-orange-200'
                        : item.kind === 'PAYWALL_BLOCKED' ? 'border-purple-500/20 bg-purple-500/10 text-purple-200'
                        : 'border-rose-500/20 bg-rose-500/10 text-rose-200'"
                    >
                      {{ item.kind }}
                    </span>
                    <span
                      v-if="item.httpAccessBlocked"
                      class="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200"
                    >
                      HTTP access blocked
                    </span>
                    <span v-if="item.articleId" class="text-[10px] text-on-surface-variant">id: {{ item.articleId }}</span>
                    <span v-if="item.sourceId" class="text-[10px] text-on-surface-variant">src: {{ item.sourceId.slice(0, 8) }}...</span>
                    <span v-if="item.confidence != null" class="text-[10px] text-on-surface-variant">conf: {{ item.confidence }}</span>
                  </div>
                  <p v-if="item.title" class="mt-1 truncate text-[11px] font-medium text-on-surface">
                    {{ item.title }}
                  </p>
                  <a
                    v-if="item.articleUrl"
                    :href="item.articleUrl"
                    target="_blank"
                    rel="noopener"
                    class="mt-0.5 block truncate text-[10px] text-cyan-400/70 hover:text-cyan-300 hover:underline"
                  >
                    {{ item.articleUrl.length > 80 ? item.articleUrl.slice(0, 80) + '...' : item.articleUrl }}
                  </a>
                  <p v-if="item.rejectedReason || item.detail" class="mt-1 line-clamp-2 text-[10px] text-on-surface-variant">
                    {{ item.detail || item.rejectedReason }}
                  </p>
                  <!-- Extraction diagnostics -->
                  <div v-if="item.diagnostics && item.diagnostics.selectedContainerSelector" class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-on-surface-variant/80">
                    <span v-if="item.diagnostics.selectedContainerSelector">selector: <strong class="text-violet-300">{{ item.diagnostics.selectedContainerSelector }}</strong></span>
                    <span v-if="item.diagnostics.selectedContainerParagraphCount != null">paras: <strong>{{ item.diagnostics.selectedContainerParagraphCount }}</strong></span>
                    <span v-if="item.diagnostics.selectedContainerTextLength != null">text: <strong>{{ item.diagnostics.selectedContainerTextLength }}</strong></span>
                    <span v-if="item.diagnostics.candidateContainerCount != null">candidates: <strong>{{ item.diagnostics.candidateContainerCount }}</strong></span>
                  </div>
                  <div v-if="item.diagnostics?.bodyRejectedReason" class="mt-0.5 text-[10px] text-rose-300/80">
                    body rejected: {{ item.diagnostics.bodyRejectedReason }}
                  </div>
                  <div v-if="item.diagnostics?.stoppedAtText" class="mt-0.5 text-[10px] text-amber-300/70">
                    stopped at: "{{ item.diagnostics.stoppedAtText.slice(0, 80) }}"
                  </div>
                  <div v-if="item.diagnostics?.stoppedAtClassOrId" class="mt-0.5 text-[10px] text-amber-300/70">
                    stopped class/id: {{ item.diagnostics.stoppedAtClassOrId.slice(0, 80) }}
                  </div>
                  <!-- Top candidates (max 3) -->
                  <div v-if="item.diagnostics?.topCandidates && item.diagnostics.topCandidates.length > 0" class="mt-1.5">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                      Top candidates ({{ item.diagnostics.topCandidates.length }})
                    </p>
                    <div
                      v-for="(c, ci) in item.diagnostics.topCandidates.slice(0, 3)"
                      :key="ci"
                      class="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px]"
                    >
                      <span class="text-violet-300/80">{{ c.selector || '?' }}</span>
                      <span class="text-on-surface-variant/50">score: {{ c.score ?? '?' }}</span>
                      <span class="text-on-surface-variant/50">paras: {{ c.paragraphCount ?? '?' }}</span>
                      <span class="text-on-surface-variant/50">len: {{ c.textLength ?? '?' }}</span>
                    </div>
                  </div>
                  <!-- Score reasons -->
                  <div v-if="item.diagnostics?.scoreReasons && item.diagnostics.scoreReasons.length > 0" class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="reason in item.diagnostics.scoreReasons.slice(0, 5)"
                      :key="reason"
                      class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                    >
                      {{ reason }}
                    </span>
                  </div>
                </div>
                <div class="shrink-0 text-right text-[10px] text-on-surface-variant">
                  <div>{{ formatLogTime(item.createdAt) }}</div>
                  <div v-if="item.extractorVersion" class="max-w-[80px] truncate text-[9px]">{{ item.extractorVersion }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        </details>

        <!-- URL Policy Evaluation panel -->
        <details v-if="showFullDevTools" class="rounded-2xl border border-outline-variant/20 bg-surface-container-high/60 px-4 py-3">
          <summary class="cursor-pointer select-none font-headline text-sm font-bold text-on-surface">
            URL Policy Evaluation
          </summary>
          <div class="mt-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h3 class="font-headline text-sm font-bold text-on-surface">Policy version comparison</h3>
                <p class="mt-1 text-xs text-on-surface-variant">
                  Production baseline vs candidate shadow URL policy metrics using labeled tuning/holdout datasets.
                </p>
              </div>
              <button
                @click="loadUrlPolicyEvaluation"
                :disabled="urlPolicyEvalLoading"
                class="rounded-lg border border-outline-variant/20 bg-surface-container px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ urlPolicyEvalLoading ? "Loading..." : "Load report" }}
              </button>
            </div>

            <div v-if="urlPolicyEvalError" class="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
              <p class="text-xs text-rose-200">{{ urlPolicyEvalError }}</p>
            </div>

            <div v-if="urlPolicyEvalResult" class="mt-3">
              <div class="rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[10px] font-bold uppercase tracking-wider text-primary">
                    Dataset: {{ urlPolicyEvalResult.datasetVersion }}
                  </span>
                  <span class="text-[10px] text-on-surface-variant">
                    Policy: {{ urlPolicyVersions }}
                  </span>
                </div>
              </div>

              <div
                v-for="(splitData, splitName) in urlPolicyEvalResult.splits"
                :key="String(splitName)"
                class="mt-3"
              >
                <h4 class="font-headline text-xs font-bold uppercase tracking-wider text-on-surface-variant/70">
                  {{ splitName }} split
                </h4>
                <div
                  v-for="(policyData, policyName) in (splitData as Record<string, any>).policies"
                  :key="String(policyName)"
                  class="mt-2 rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                      :class="String(policyName).includes('production') ? 'bg-cyan-500/15 text-cyan-200' : 'bg-violet-500/15 text-violet-200'"
                    >
                      {{ (policyName as string).includes('production') ? 'production' : 'candidate' }}
                    </span>
                    <span class="text-[10px] text-on-surface-variant">{{ (policyData as any).policyVersion || policyName }}</span>
                  </div>
                  <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-on-surface-variant">
                    <span>evaluated: <strong>{{ (policyData as any).counts?.evaluated ?? 0 }}</strong></span>
                    <span>accepted: <strong>{{ (policyData as any).counts?.accepted ?? 0 }}</strong></span>
                    <span>rejected: <strong>{{ (policyData as any).counts?.rejected ?? 0 }}</strong></span>
                    <span>uncertain: <strong class="text-amber-300">{{ (policyData as any).counts?.uncertain ?? 0 }}</strong></span>
                    <span title="accepted true articles / all accepted">precision: <strong>{{ ((policyData as any).rates?.articleAcceptPrecision ?? 0).toFixed(4) }}</strong></span>
                    <span title="accepted true articles / all true articles">recall: <strong>{{ ((policyData as any).rates?.articleAcceptRecall ?? 0).toFixed(4) }}</strong></span>
                    <span title="rejected true articles / all true articles" class="text-rose-300">false reject: <strong>{{ ((policyData as any).rates?.falseRejectRate ?? 0).toFixed(4) }}</strong></span>
                    <span title="accepted non-articles / all accepted" class="text-amber-300">leakage: <strong>{{ ((policyData as any).rates?.nonArticleLeakageRate ?? 0).toFixed(4) }}</strong></span>
                    <span title="UNCERTAIN / all evaluated">uncertain rate: <strong>{{ ((policyData as any).rates?.uncertainRate ?? 0).toFixed(4) }}</strong></span>
                    <span title="(ACCEPT + REJECT) / all evaluated">coverage: <strong>{{ ((policyData as any).rates?.policyCoverage ?? 0).toFixed(4) }}</strong></span>
                    <span title="uncertain true articles / all true articles">uncert.article: <strong>{{ ((policyData as any).rates?.uncertainArticleRate ?? 0).toFixed(4) }}</strong></span>
                    <span title="uncertain non-articles / all non-articles">uncert.non-article: <strong>{{ ((policyData as any).rates?.uncertainNonArticleRate ?? 0).toFixed(4) }}</strong></span>
                  </div>
                </div>
              </div>

              <!-- Comparison section -->
              <div v-if="urlPolicyEvalResult.comparison?.length" class="mt-3 rounded-xl border border-outline-variant/20 bg-surface-container px-3 py-2">
                <h4 class="font-headline text-xs font-bold uppercase tracking-wider text-on-surface-variant/70">
                  Production vs candidate delta
                  <span class="ml-1 text-[9px] font-normal normal-case tracking-normal text-on-surface-variant/60">
                    ({{ urlPolicyComparisonVersions }})
                  </span>
                </h4>
                <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-on-surface-variant">
                  <div
                    v-for="(cmp, ci) in urlPolicyEvalResult.comparison"
                    :key="ci"
                    class="flex items-baseline gap-1"
                  >
                    <span>{{ (cmp as any).metric }}:</span>
                    <span>{{ (cmp as any).productionValue != null ? Number((cmp as any).productionValue).toFixed(4) : 'n/a' }}</span>
                    <span class="text-on-surface-variant/50">→</span>
                    <span>{{ (cmp as any).candidateValue != null ? Number((cmp as any).candidateValue).toFixed(4) : 'n/a' }}</span>
                    <span
                      :class="(cmp as any).delta > 0 ? 'text-emerald-300' : (cmp as any).delta < 0 ? 'text-rose-300' : 'text-on-surface-variant/50'"
                    >
                      ({{ (cmp as any).delta != null ? ((cmp as any).delta >= 0 ? '+' : '') + Number((cmp as any).delta).toFixed(4) : 'n/a' }})
                    </span>
                  </div>
                </div>
              </div>

              <!-- Sample groups -->
              <div class="mt-3 grid gap-3 sm:grid-cols-3">
                <div v-if="urlPolicySamples.falseRejectSamples.length" class="rounded-xl border border-rose-500/15 bg-rose-500/5 px-2.5 py-2">
                  <p class="text-[9px] font-bold uppercase tracking-wider text-rose-300/80">
                    False rejects ({{ urlPolicySamples.falseRejectSamples.length }})
                  </p>
                  <div
                    v-for="(sample, si) in urlPolicySamples.falseRejectSamples.slice(0, 5)"
                    :key="si"
                    class="mt-1 truncate text-[10px] text-on-surface-variant"
                    :title="(sample as any).url"
                  >
                    {{ (sample as any).url?.slice(0, 60) || 'N/A' }}
                  </div>
                </div>
                <div v-if="urlPolicySamples.nonArticleLeakageSamples.length" class="rounded-xl border border-amber-500/15 bg-amber-500/5 px-2.5 py-2">
                  <p class="text-[9px] font-bold uppercase tracking-wider text-amber-300/80">
                    Leakage ({{ urlPolicySamples.nonArticleLeakageSamples.length }})
                  </p>
                  <div
                    v-for="(sample, si) in urlPolicySamples.nonArticleLeakageSamples.slice(0, 5)"
                    :key="si"
                    class="mt-1 truncate text-[10px] text-on-surface-variant"
                    :title="(sample as any).url"
                  >
                    {{ (sample as any).url?.slice(0, 60) || 'N/A' }}
                  </div>
                </div>
                <div v-if="urlPolicySamples.uncertainSamples.length" class="rounded-xl border border-sky-500/15 bg-sky-500/5 px-2.5 py-2">
                  <p class="text-[9px] font-bold uppercase tracking-wider text-sky-300/80">
                    Uncertain ({{ urlPolicySamples.uncertainSamples.length }})
                  </p>
                  <div
                    v-for="(sample, si) in urlPolicySamples.uncertainSamples.slice(0, 5)"
                    :key="si"
                    class="mt-1 truncate text-[10px] text-on-surface-variant"
                    :title="(sample as any).url"
                  >
                    {{ (sample as any).url?.slice(0, 60) || 'N/A' }}
                  </div>
                </div>
              </div>
              <p v-if="!urlPolicySamples.falseRejectSamples.length && !urlPolicySamples.nonArticleLeakageSamples.length && !urlPolicySamples.uncertainSamples.length" class="mt-3 text-[11px] text-on-surface-variant">
                No bounded decision samples are available for this report.
              </p>
            </div>
            <p v-else-if="!urlPolicyEvalLoading" class="mt-3 text-xs text-on-surface-variant">
              Click "Load report" to fetch the URL policy evaluation report.
            </p>
          </div>
        </details>



        <!-- Maintenance cleanup panel -->
        <div v-if="showFullDevTools" class="border-t border-outline-variant/20 pt-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="font-headline text-sm font-bold text-on-surface">
                Maintenance
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                Safe, bounded cleanup of old unowned articles and stale pipeline artifacts. Dry-run by default; deletion requires explicit confirmation.
              </p>
            </div>
          </div>

          <!-- A. Old unowned articles -->
          <div class="mt-4 rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3">
            <h4 class="font-headline text-xs font-bold text-on-surface">
              Old unowned articles
            </h4>
            <p class="mt-1 text-[11px] text-on-surface-variant">
              Remove articles older than the retention window when no user has saved, favorited, read-latered, or shared them.
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                @click="inspectOldArticles"
                :disabled="isInspectingOldArticles"
                class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isInspectingOldArticles ? "Inspecting..." : "Inspect old articles" }}
              </button>
              <button
                v-if="cleanupDeletionEnabled"
                @click="deleteOldArticles"
                :disabled="isDeletingOldArticles"
                class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isDeletingOldArticles ? "Deleting..." : "Delete old unowned articles" }}
              </button>
            </div>

            <div v-if="oldArticlesResult" class="mt-3 rounded-lg border border-outline-variant/15 bg-surface-container-highest/50 px-3 py-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  :class="oldArticlesResult.dryRun ? 'bg-sky-500/15 text-sky-300' : 'bg-rose-500/15 text-rose-300'"
                >
                  {{ oldArticlesResult.dryRun ? "dry-run" : "deleted" }}
                </span>
                <span class="text-[10px] text-on-surface-variant">cutoff: {{ oldArticlesResult.cutoff.slice(0, 10) }}</span>
                <span class="text-[10px] text-on-surface-variant">{{ Math.round(oldArticlesResult.durationMs) }}ms</span>
                <span class="text-[10px] text-on-surface-variant">limit: {{ oldArticlesResult.limit }}</span>
              </div>
              <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
                <span>inspected: <strong>{{ oldArticlesResult.inspected }}</strong></span>
                <span>eligible: <strong class="text-amber-300">{{ oldArticlesResult.eligibleForDeletion }}</strong></span>
                <span>deleted: <strong :class="oldArticlesResult.deleted > 0 ? 'text-rose-300' : 'text-on-surface-variant'">{{ oldArticlesResult.deleted }}</strong></span>
                <span>protected: <strong class="text-emerald-300">{{ oldArticlesResult.protected }}</strong></span>
                <span>skipped: <strong>{{ oldArticlesResult.skipped }}</strong></span>
              </div>
              <div v-if="Object.keys(oldArticlesResult.protectedReasons).length > 0" class="mt-2">
                <span class="text-[9px] font-bold uppercase tracking-wider text-emerald-300/70">Protected by relation:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, reason) in oldArticlesResult.protectedReasons"
                    :key="`ar-prot-${reason}`"
                    class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200"
                  >
                    {{ reason }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="Object.keys(oldArticlesResult.skippedReasons).length > 0" class="mt-1.5">
                <span class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">Skipped reasons:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, reason) in oldArticlesResult.skippedReasons"
                    :key="`ar-skip-${reason}`"
                    class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                  >
                    {{ reason }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="oldArticlesResult.bySource.length > 0" class="mt-1.5">
                <span class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">By source (top 10):</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="entry in oldArticlesResult.bySource.slice(0, 10)"
                    :key="`ar-src-${entry.sourceId}`"
                    class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                  >
                    {{ entry.sourceId ? entry.sourceId.slice(0, 8) + '...' : 'null' }}: {{ entry.count }}
                  </span>
                </div>
              </div>
              <div v-if="oldArticlesResult.sampleDeletedOrWouldDelete.length > 0" class="mt-2">
                <p class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                  Samples ({{ oldArticlesResult.sampleDeletedOrWouldDelete.length }})
                </p>
                <div class="mt-1 max-h-48 space-y-1 overflow-y-auto pr-1">
                  <div
                    v-for="sample in oldArticlesResult.sampleDeletedOrWouldDelete"
                    :key="sample.id"
                    class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] text-on-surface-variant"
                  >
                    <span class="font-mono text-[9px] text-on-surface-variant/50">#{{ sample.id }}</span>
                    <span v-if="sample.title" class="truncate max-w-[200px] text-on-surface">{{ sample.title }}</span>
                    <span class="text-on-surface-variant/50">{{ sample.effectiveDate.slice(0, 10) }}</span>
                    <a
                      v-if="sample.url"
                      :href="sample.url"
                      target="_blank"
                      rel="noopener"
                      class="truncate max-w-[180px] text-cyan-400/60 hover:text-cyan-300 hover:underline"
                    >
                      {{ truncateStaleUrl(sample.url) }}
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- B. Pipeline artifacts -->
          <div class="mt-3 rounded-xl border border-outline-variant/20 bg-surface-container px-4 py-3">
            <h4 class="font-headline text-xs font-bold text-on-surface">
              Pipeline artifacts
            </h4>
            <p class="mt-1 text-[11px] text-on-surface-variant">
              Clean old pipeline diagnostic artifacts that are resolved, superseded, or safe history.
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                @click="inspectPipelineArtifacts"
                :disabled="isInspectingArtifacts"
                class="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-100 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isInspectingArtifacts ? "Inspecting..." : "Inspect pipeline artifacts" }}
              </button>
              <button
                v-if="cleanupDeletionEnabled"
                @click="deletePipelineArtifacts"
                :disabled="isDeletingArtifacts"
                class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isDeletingArtifacts ? "Deleting..." : "Delete pipeline artifacts" }}
              </button>
            </div>

            <div v-if="pipelineArtifactsResult" class="mt-3 rounded-lg border border-outline-variant/15 bg-surface-container-highest/50 px-3 py-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  :class="pipelineArtifactsResult.dryRun ? 'bg-sky-500/15 text-sky-300' : 'bg-rose-500/15 text-rose-300'"
                >
                  {{ pipelineArtifactsResult.dryRun ? "dry-run" : "deleted" }}
                </span>
                <span class="text-[10px] text-on-surface-variant">cutoff: {{ pipelineArtifactsResult.cutoff.slice(0, 10) }}</span>
                <span class="text-[10px] text-on-surface-variant">{{ Math.round(pipelineArtifactsResult.durationMs) }}ms</span>
                <span class="text-[10px] text-on-surface-variant">limit: {{ pipelineArtifactsResult.limit }}</span>
              </div>
              <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
                <span>inspected: <strong>{{ pipelineArtifactsResult.inspected }}</strong></span>
                <span>eligible: <strong class="text-amber-300">{{ pipelineArtifactsResult.eligibleForDeletion }}</strong></span>
                <span>deleted: <strong :class="pipelineArtifactsResult.deleted > 0 ? 'text-rose-300' : 'text-on-surface-variant'">{{ pipelineArtifactsResult.deleted }}</strong></span>
                <span>protected: <strong class="text-emerald-300">{{ pipelineArtifactsResult.protected }}</strong></span>
                <span>skipped: <strong>{{ pipelineArtifactsResult.skipped }}</strong></span>
              </div>
              <div v-if="Object.keys(pipelineArtifactsResult.byStatus).length > 0" class="mt-2">
                <span class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">By status:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, status) in pipelineArtifactsResult.byStatus"
                    :key="`pa-status-${status}`"
                    class="rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                    :class="headlessStatusBadgeClass(status as string)"
                  >
                    {{ status }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="Object.keys(pipelineArtifactsResult.byArtifactType).length > 0" class="mt-1.5">
                <span class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">By artifact type:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, type) in pipelineArtifactsResult.byArtifactType"
                    :key="`pa-type-${type}`"
                    class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                  >
                    {{ type }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="Object.keys(pipelineArtifactsResult.protectedReasons).length > 0" class="mt-1.5">
                <span class="text-[9px] font-bold uppercase tracking-wider text-emerald-300/70">Protected reasons:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, reason) in pipelineArtifactsResult.protectedReasons"
                    :key="`pa-prot-${reason}`"
                    class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200"
                  >
                    {{ reason }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="Object.keys(pipelineArtifactsResult.skippedReasons).length > 0" class="mt-1.5">
                <span class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">Skipped reasons:</span>
                <div class="mt-0.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="(count, reason) in pipelineArtifactsResult.skippedReasons"
                    :key="`pa-skip-${reason}`"
                    class="rounded bg-surface-container-highest px-1.5 py-0.5 text-[9px] font-medium text-on-surface-variant"
                  >
                    {{ reason }}: {{ count }}
                  </span>
                </div>
              </div>
              <div v-if="pipelineArtifactsResult.sampleDeletedOrWouldDelete.length > 0" class="mt-2">
                <p class="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                  Samples ({{ pipelineArtifactsResult.sampleDeletedOrWouldDelete.length }})
                </p>
                <div class="mt-1 max-h-48 space-y-1 overflow-y-auto pr-1">
                  <div
                    v-for="sample in pipelineArtifactsResult.sampleDeletedOrWouldDelete"
                    :key="sample.id"
                    class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] text-on-surface-variant"
                  >
                    <span
                      class="rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider"
                      :class="headlessStatusBadgeClass(sample.status)"
                    >
                      {{ sample.status }}
                    </span>
                    <span class="text-[9px] font-medium text-amber-300/70">{{ sample.reason }}</span>
                    <a
                      v-if="sample.targetUrl"
                      :href="sample.targetUrl"
                      target="_blank"
                      rel="noopener"
                      class="truncate max-w-[180px] text-cyan-400/60 hover:text-cyan-300 hover:underline"
                    >
                      {{ truncateStaleUrl(sample.targetUrl) }}
                    </a>
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
                v-if="pipelineResetEnabled"
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
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useFeedStore } from "~/stores/feedStore";
import { $api } from "~/utils/api";
import {
  describeRedirectStatus,
  type RedirectStatusDescriptor,
} from "~/../shared/redirect-status";

definePageMeta({
  layout: "app-layout",
});

const authStore = useAuthStore();
const feedStore = useFeedStore();

const canAccessDevPanel = ref(false);
const canRunManualPipeline = ref(false);
const canRunArticleDiscovery = ref(false);
const canRunDestructiveActions = ref(false);
const pipelineResetEnabled = ref(false);
const cleanupDeletionEnabled = ref(false);
const canUseFullDevTools = ref(false);
const isPipelineRunning = ref(false);
const isEnrichingExistingArticles = ref(false);
const isAgent3Running = ref(false);
const agent3MaxArticles = ref(10);
const agent3IncludeEnriched = ref(true);
const agent3ForceReprocess = ref(true);
const agent3BrowserFallback = ref(false);
const agent3BrowserFallbackMaxAttempts = ref(3);
const agent3BrowserTimeoutMs = ref(25000);
const agent3MaxArticlesPerSource = ref(5);

// ── URL Policy Evaluation ─────────────────────────────────────────────────
const urlPolicyEvalResult = ref<any>(null);
const urlPolicyEvalLoading = ref(false);
const urlPolicyEvalError = ref<string | null>(null);
const urlPolicyVersions = computed(() => {
  const policies = urlPolicyEvalResult.value?.splits?.tuning?.policies;
  if (!policies) return "N/A";
  return Object.entries(policies)
    .map(([key, value]: [string, any]) => value?.policyVersion || key)
    .join(" vs ");
});
const urlPolicyComparisonVersions = computed(() => {
  const comparison = urlPolicyEvalResult.value?.comparison;
  const first = Array.isArray(comparison) ? comparison[0] : null;
  if (!first) return "";
  return `${first.productionPolicyVersion || 'production'} vs ${first.candidatePolicyVersion || 'candidate'}`;
});
const urlPolicySamples = computed(() => {
  const groups = {
    falseRejectSamples: [] as any[],
    nonArticleLeakageSamples: [] as any[],
    uncertainSamples: [] as any[],
  };
  const seen = new Set<string>();
  for (const split of Object.values(urlPolicyEvalResult.value?.splits || {}) as any[]) {
    const candidate = Object.entries(split?.policies || {})
      .find(([name]) => !name.includes("production"))?.[1] as any;
    for (const group of Object.keys(groups) as Array<keyof typeof groups>) {
      for (const sample of candidate?.samples?.[group] || []) {
        const key = `${group}:${sample?.url || ""}:${sample?.decision || ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          groups[group].push(sample);
        }
      }
    }
  }
  return groups;
});
const agent3Progress = ref<{
  eligibleNow: number;
  recentlyBlocked?: number;
  retryableNow?: number;
  deferred?: number;
  nextRetryAt?: string | null;
  nonRetryableCurrentVersionFailures?: number;
  totalInScope: number;
  enrichedInScope: number;
  needingInitialEnrichment: number;
  failedRetryable: number;
  needsCurrentVersionReprocess: number;
  currentVersionComplete: number;
  progressTruncated: boolean;
  progressScanned: number;
  selectedMode: { includeEnriched: boolean; forceReprocess: boolean; hasArticleFilter: boolean; hasSourceFilter: boolean };
  latestRun: {
    pipelineRunId: string | null;
    processed: number;
    successfullyEnriched: number;
    rejected: number;
    persistedOutcomes: number;
    systemPersistFailed: number;
    durationMs: number | null;
    finishedAt: string | null;
    byKind: Record<string, number>;
    browserFallbackStats?: {
      enabled: boolean;
      attempted: number;
      succeeded: number;
      failed: number;
      runtimeUnavailable: number;
      rateLimited: number;
      stoppedReason: string | null;
    } | null;
    optionsUsed?: {
      browserFallback: boolean;
      browserFallbackMaxAttempts: number;
      browserTimeoutMs: number;
      includeEnriched: boolean;
      forceReprocess: boolean;
      maxArticles: number;
      maxArticlesPerSource: number;
    } | null;
    sourceCooldowns?: Array<{ sourceId: string; hostname: string; reason: string; failureCount: number; skippedInRun: number }> | null;
  } | null;
  remainingAfterLatestRun: number;
} | null>(null);
const agent3ProgressLoading = ref(false);
const dailyPipelineTelemetry = ref<any>({ loading: false, loaded: false, error: null, run: null, stageTimings: [], batches: [], pagination: { truncated: false } });
const dailyLockRecoveryModalOpen = ref(false);
const dailyLockRecoveryLoading = ref(false);
const dailyLockRecoveryToken = ref("");
const agent3RejectionLoading = ref(false);
const agent3RejectionFilter = ref<string>("all");
const agent3RejectionScope = ref<string>("latest_run");
const agent3RejectionKinds = ["LOW_CONTENT_QUALITY", "UNSUPPORTED_STRUCTURE", "HTTP_ACCESS_BLOCKED", "INTERSTITIAL_OR_CHALLENGE", "HEADLESS_REQUIRED", "PAYWALL_BLOCKED", "RETRYABLE_FAILURE", "CANONICAL_MISMATCH"];
const agent3RejectionData = ref<{
  ok: boolean;
  summary: {
    totalReturned: number;
    byKind: Record<string, number>;
    byHostname?: Record<string, number>;
    httpAccessBlocked?: number;
    latestOnly?: boolean;
  };
  items: Array<{
    id: string;
    createdAt: string;
    pipelineRunId: string | null;
    articleId: number | null;
    title: string | null;
    articleUrl: string | null;
    sourceId: string | null;
    categoryId: string | null;
    kind: string;
    rejectedReason: string | null;
    detail: string | null;
    confidence: number | null;
    extractorVersion: string | null;
    httpAccessBlocked: boolean;
    diagnostics: {
      selectedContainerSelector: string | null;
      selectedContainerScore: number | null;
      selectedContainerParagraphCount: number | null;
      selectedContainerTextLength: number | null;
      candidateContainerCount: number | null;
      bodyRejectedReason: string | null;
      scoreReasons: string[];
      bodySource: string | null;
      linkTextRatio: number | null;
      boilerplatePenalty: number | null;
      topCandidates: Array<{
        selector: string | null;
        score: number | null;
        paragraphCount: number | null;
        textLength: number | null;
        reasons: string[];
      }>;
      stoppedAtText: string | null;
      stoppedAtClassOrId: string | null;
      excludedBlockCount: number | null;
    };
  }>;
} | null>(null);
const agent3Summary = ref<{
  pipelineRunId: string;
  articleCount: number;
  persisted: number;
  failed: number;
  byKind: Record<string, number>;
  artifactCount: number;
  optionsUsed?: { includeEnriched: boolean; forceReprocess: boolean; browserFallback?: boolean };
  browserFallbackStats?: { attempted: number; succeeded: number; failed: number; runtimeUnavailable: number; rateLimited: number } | null;
  sourceCooldowns?: Array<{ sourceId: string; hostname: string; reason: string; failureCount: number; skippedInRun: number }> | null;
  successfullyEnriched?: number;
  rejected?: number;
  persistedOutcomes?: number;
  systemPersistFailed?: number;
} | null>(null);
const isArticleDiscoveryRunning = ref(false);
const isHardCaseQueueRunning = ref(false);
const isClearingLogs = ref(false);
const isInspectingHeadless = ref(false);
const isRunningHeadlessBrowser = ref(false);
const isRecoveringHeadless = ref(false);
const retryingHeadlessArtifactId = ref<string | null>(null);
const headlessQueueLoading = ref(false);
const headlessQueueView = ref<"active" | "history" | "all">("active");
const headlessQueueViewOptions = ["active", "history", "all"] as const;

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
  dateAnomalySamples: StaleSample[];
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
  nextEligibleAt: string | null;
  cooldownDeferred: boolean;
  quality: string | null;
  confidence: string | null;
  escalationReasons: string[];
  headlessProcessingStartedAt: string | null;
  lastBrowserAttemptAt: string | null;
  lastBrowserFinishedAt: string | null;
  headlessRecoveryCount: number | null;
  lastHeadlessRecoveryAt: string | null;
  browserFallbackRan: boolean;
  candidateCount: number | null;
  staleSamples: StaleSample[];
  dateAnomalySamples: StaleSample[];
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
  browserBlockedReason: string | null;
  browserRateLimited: boolean;
  browserRateLimitReason: string | null;
  browserRateLimitedAt: string | null;
  browserRetryAfterAt: string | null;
  browserRateLimitedCount: number | null;
  browserDetailEvaluationStoppedReason: string | null;
  skippedDueToBrowserCooldown: boolean;
  browserCooldownUntil: string | null;
  lastBrowserCooldownSkipAt: string | null;
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
const hardSourceSummary = ref({
  evidenceTargetCount: 0,
  qualifyingHardSourceCount: 0,
  cooldownOnlyCount: 0,
  resolvedOrProductiveCount: 0,
});

type HardSourceProfileEntry = {
  id: string;
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
  staticQuality: string | null;
  browserStatus: string | null;
  failureCount: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  lastStaticStatus: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  lastInsertedCount: number | null;
  dominantReasons: string[];
  suggestedNextAction: string | null;
  profileConfidence: string | null;
  lifecycleState: string | null;
  recoverySuggestion: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolvedReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Stable logical target key (sourceId/categoryId/normalized target URL). */
  key?: string | null;
  /** Number of raw evidence rows aggregated under this logical target. */
  evidenceCount?: number | null;
  /** Bounded chronological history, newest first. */
  history?: HardSourceProfileEntry[];
};

const hardSourceProfiles = ref<HardSourceProfileEntry[]>([]);
const hardSourceProfilesLoading = ref(false);
const reliabilityDiagnosticsLoading = ref(false);
const reconciliationLoading = ref(false);
const reconciliationModalMarkerId = ref<string | null>(null);
const reconciliationToken = ref('');
const hardSourceRepairLoading = ref(false);
const hardSourceRepairToken = ref('');
const hardSourceRepairModalOpen = ref(false);
const hardSourceRepairError = ref<string | null>(null);
const hardSourceRepairResult = ref<any>(null);
const reliabilityDiagnosticsLoaded = ref(false);
const reliabilityDiagnosticsError = ref<string | null>(null);
const reliabilityDiagnostics = ref<any>({
  notifications: { markers: [] },
  redirects: [],
  rssSkipReasons: {},
  rssOwnership: { productiveSkip: 0, waitingForEvidenceSkip: 0, invalidFeedEscalation: 0, scopeMismatchEscalation: 0, explicitAdminBypass: 'targeted requests only' },
  browserStatuses: {},
});

// Agent 2 health state
const agent2HealthTargets = ref<Array<{
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
  health: string;
  score: number;
  lastProductiveAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastStaticStatus: string | null;
  lastBrowserStatus: string | null;
  currentLifecycleState: string;
  recommendedAction: string | null;
  browserCooldownUntil: string | null;
  browserRateLimitedAt: string | null;
  browserRetryAfterAt: string | null;
  browserRateLimitReason: string | null;
  lastBrowserCooldownSkipAt: string | null;
  cooldownActive: boolean;
  cooldownReason: string | null;
  cooldownStartedAt: string | null;
  retryAfter: string | null;
  lastHistoricalCooldownAt: string | null;
  lastBrowserAttemptAt: string | null;
  lastBrowserFinishedAt: string | null;
}>>([]);
const agent2HealthLoading = ref(false);

const headlessQueueSummary = ref<{ total: number; byStatus: Record<string, number>; activeTotal: number; historyTotal: number; retryableTotal: number; cooldownPendingTotal: number; resolvedRecentTotal: number; cooldownOnlyTotal?: number; retryableExcludingCooldown?: number } | null>(null);
const headlessBrowserEnvDisabled = ref(false);
const agentLogs = ref<Array<{ id: string; status: string; displayStatus?: string; agentPrefix?: string; sourceId?: string | null; errorLog?: string | null; createdAt: string; executionTimeMs: number }>>([]);
const agentSourceCount = ref(0);
const agent1RunSummary = ref<{
  run: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    targetCount: number;
    candidatesFound: number;
    inserted: number;
    skipped: number;
    failed: number;
    artifactCount: number;
  } | null;
  items: Array<{
    id: string;
    createdAt: string;
    sourceId: string | null;
    categoryId: string | null;
    status: string;
    passed: boolean;
    handedToAgent2: boolean;
    rssActive: boolean;
    rateLimited: boolean;
    retryAt: string | null;
    sourceUrl: string | null;
    candidates: number;
    inserted: number;
    skipped: number;
    failed: number;
    enriched: number;
    feedUrl: string | null;
    rssUrl: string | null;
    feedFormat: string | null;
    failureReason: string | null;
    urlPolicyRejected?: number;
  }>;
}>({ run: null, items: [] });

type Agent2Progress = {
  totalEligibleNow: number;
  latestRunId: string | null;
  latestRunStartedAt: string | null;
  latestRunFinishedAt: string | null;
  lastDurationMs: number | null;
  processedLastRun: number;
  deferredLastRun: number;
  remainingEligible: number;
  stoppedReason: string | null;
  recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }>;
};

type Agent1Progress = {
  totalEligibleNow: number;
  latestRunId: string | null;
  latestRunStartedAt: string | null;
  latestRunFinishedAt: string | null;
  lastDurationMs: number | null;
  processedLastRun: number;
  deferredLastRun: number;
  remainingEligible: number;
  stoppedReason: string | null;
  recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }>;
  lastRunAt: string | null;
};

const agent2Progress = ref<Agent2Progress | null>(null);
const agent2ProgressLoading = ref(false);
const agent1Progress = ref<Agent1Progress | null>(null);
const agent1ProgressLoading = ref(false);

const toastClass = computed(() =>
  toast.value.type === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100",
);
const toastIcon = computed(() => (toast.value.type === "success" ? "check_circle" : "error"));
const isAdminUser = computed(() => authStore.user?.isAdmin === true || authStore.user?.role === "ADMIN");
const showAdminPipelinePanel = computed(() => canAccessDevPanel.value);
const showFullDevTools = computed(() => canAccessDevPanel.value && canUseFullDevTools.value);
const formatTelemetryMs = (ms: number | null | undefined) => {
  const value = Number.isFinite(ms) ? Math.max(0, Number(ms)) : 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60000).toFixed(1)}m`;
};
const telemetryProcessed = computed(() => dailyPipelineTelemetry.value.stageTimings.reduce((sum: number, stage: any) => sum + (stage.processed || 0), 0));
const telemetrySucceeded = computed(() => dailyPipelineTelemetry.value.stageTimings.reduce((sum: number, stage: any) => sum + (stage.succeeded || 0), 0));
const telemetryDuration = (key: string) => dailyPipelineTelemetry.value.stageTimings.reduce((sum: number, stage: any) => sum + (stage[key] || 0), 0);
const telemetryCount = (key: string) => dailyPipelineTelemetry.value.stageTimings.reduce((sum: number, stage: any) => sum + (stage[key] || 0), 0);
const dailyTelemetrySlowestStage = computed(() => [...dailyPipelineTelemetry.value.stageTimings].sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0))[0]?.stage || null);
const agent2BatchDisabledReason = computed(() => {
  if (isArticleDiscoveryRunning.value) return null;
  if (agent1Progress.value != null && agent1Progress.value.remainingEligible > 0) {
    return `Finish Agent 1 batches first. ${agent1Progress.value.remainingEligible} Agent 1 target(s) remain.`;
  }
  if (!canRunArticleDiscovery.value) return "manual Agent 2 runs are disabled by server policy";
  if (agent2Progress.value != null && agent2Progress.value.totalEligibleNow === 0) return "no eligible Agent 2 targets";
  return null;
});
const isAgent2BatchDisabled = computed(() =>
  isArticleDiscoveryRunning.value ||
  (agent1Progress.value != null && agent1Progress.value.remainingEligible > 0) ||
  !canRunArticleDiscovery.value ||
  (agent2Progress.value != null && agent2Progress.value.totalEligibleNow === 0)
);

let devPanelPollTimer: number | null = null;
let devPanelRefreshInFlight = false;
const DEV_PANEL_POLL_MS = 10000;

const formatLogTime = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const formatRetryDateTime = (value: string): string => {
  const retryAt = new Date(value);
  if (!Number.isFinite(retryAt.getTime())) return "unknown";

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const sameLocalDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
  const relativeDay = sameLocalDay(retryAt, now)
    ? "today"
    : sameLocalDay(retryAt, tomorrow)
      ? "tomorrow"
      : null;
  const formatted = retryAt.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return relativeDay ? `${formatted}, ${relativeDay}` : formatted;
};

const agent1Summary = computed(() => {
  const run = agent1RunSummary.value.run;

  return {
    latestRun: run
      ? {
          createdAt: run.finishedAt || run.startedAt,
          durationMs: run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null,
          targets: run.targetCount,
          candidates: run.candidatesFound,
          inserted: run.inserted,
          skipped: run.skipped,
          failed: run.failed,
          artifacts: run.artifactCount,
        }
      : null,
    recentSourceOutcomes: agent1RunSummary.value.items.map((item) => ({
      ...item,
      targetType: item.categoryId ? "category" : "source",
      resultType: item.rateLimited
        ? "rate_limited"
        : item.rssActive
        ? "rss_active_no_new_articles"
        : item.passed
          ? "pass"
          : item.handedToAgent2
            ? "handoff"
            : "failed",
      failureReason: item.failureReason || "Agent 1 did not load articles for this target.",
    })),
  };
});

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
    pipelineResetEnabled.value = false;
    cleanupDeletionEnabled.value = false;
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
      pipelineResetEnabled.value = false;
      cleanupDeletionEnabled.value = false;
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
      pipelineResetEnabled?: boolean;
      cleanupDeletionEnabled?: boolean;
      diagnosticsEnabled?: boolean;
    };
    canAccessDevPanel.value = payload.canAccess === true;
    canRunManualPipeline.value = payload.manualPipelineEnabled !== false;
    canRunArticleDiscovery.value = payload.manualArticleDiscoveryEnabled === true;
    canRunDestructiveActions.value = payload.destructiveActionsEnabled === true;
    pipelineResetEnabled.value = payload.pipelineResetEnabled === true;
    cleanupDeletionEnabled.value = payload.cleanupDeletionEnabled === true;
    canUseFullDevTools.value = payload.diagnosticsEnabled === true;
    return canAccessDevPanel.value;
  } catch {
    canAccessDevPanel.value = false;
    canRunManualPipeline.value = false;
    canRunArticleDiscovery.value = false;
    canRunDestructiveActions.value = false;
    pipelineResetEnabled.value = false;
    cleanupDeletionEnabled.value = false;
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

const loadAgent1RunSummary = async () => {
  if (!showFullDevTools.value) return;
  const response = await $api<{ ok: boolean; run: typeof agent1RunSummary.value.run; items: typeof agent1RunSummary.value.items }>("/api/dev/agent1-run-summary");
  agent1RunSummary.value = {
    run: response.run || null,
    items: response.items || [],
  };
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

const loadAgent2Progress = async () => {
  if (!showFullDevTools.value) return;
  agent2ProgressLoading.value = true;
  try {
    const response = await $api<{ ok: boolean; progress: Agent2Progress }>("/api/dev/agent2-progress");
    agent2Progress.value = response.progress || null;
  } catch {
    agent2Progress.value = null;
  } finally {
    agent2ProgressLoading.value = false;
  }
};

const loadAgent1Progress = async () => {
  if (!showFullDevTools.value) return;
  agent1ProgressLoading.value = true;
  try {
    const response = await $api<{ ok: boolean; progress: Agent1Progress }>("/api/dev/agent1-progress");
    agent1Progress.value = response.progress || null;
  } catch {
    agent1Progress.value = null;
  } finally {
    agent1ProgressLoading.value = false;
  }
};

const loadAgent3Progress = async () => {
  if (!showFullDevTools.value) return;
  agent3ProgressLoading.value = true;
  try {
    const params = new URLSearchParams({
      includeEnriched: String(agent3IncludeEnriched.value),
      forceReprocess: String(agent3ForceReprocess.value),
    });
    const response = await $api<{ ok: boolean; progress: typeof agent3Progress.value }>(
      `/api/dev/agent3-progress?${params}`,
    );
    agent3Progress.value = response.progress || null;
  } catch {
    agent3Progress.value = null;
  } finally {
    agent3ProgressLoading.value = false;
  }
};

const loadAgent3RejectionDiagnostics = async () => {
  if (!showFullDevTools.value) return;
  agent3RejectionLoading.value = true;
  try {
    const params = new URLSearchParams({ limit: '25' });
    if (agent3RejectionFilter.value !== 'all') {
      params.set('kind', agent3RejectionFilter.value);
    }
    const latestRunId = agent3Summary.value?.pipelineRunId || agent3Progress.value?.latestRun?.pipelineRunId || null;
    if (agent3RejectionScope.value === "latest_run" && latestRunId) {
      params.set("runId", latestRunId);
      params.set("includeDuplicates", "true");
    }
    const response = await $api<{
      ok: boolean;
      summary: NonNullable<typeof agent3RejectionData.value>["summary"];
      items: NonNullable<typeof agent3RejectionData.value>['items'];
    }>(`/api/dev/agent3-rejection-diagnostics?${params}`);
    agent3RejectionData.value = response as NonNullable<typeof agent3RejectionData.value>;
  } catch {
    agent3RejectionData.value = null;
  } finally {
    agent3RejectionLoading.value = false;
  }
};

const loadUrlPolicyEvaluation = async () => {
  if (!showFullDevTools.value) return;
  urlPolicyEvalLoading.value = true;
  urlPolicyEvalError.value = null;
  try {
    const response = await $api<{
      ok: boolean;
      report: any;
    }>("/api/dev/url-policy-evaluation");
    if (!response.ok || !response.report) {
      urlPolicyEvalError.value = "No evaluation report available.";
      urlPolicyEvalResult.value = null;
    } else {
      urlPolicyEvalResult.value = response.report;
    }
  } catch (error: any) {
    urlPolicyEvalError.value = error?.data?.statusMessage || error?.message || "Failed to load URL policy evaluation.";
    urlPolicyEvalResult.value = null;
  } finally {
    urlPolicyEvalLoading.value = false;
  }
};

const loadHeadlessQueue = async () => {
  if (!showFullDevTools.value) return;
  headlessQueueLoading.value = true;
  try {
    const viewParam = `?view=${headlessQueueView.value}`;
    const response = await $api<{
      ok: boolean;
      items: typeof headlessQueueItems.value;
      summary: { total: number; byStatus: Record<string, number>; activeTotal: number; historyTotal: number; retryableTotal: number; cooldownPendingTotal: number; resolvedRecentTotal: number; cooldownOnlyTotal?: number; retryableExcludingCooldown?: number };
      view: string;
      browserFallbackEnabled: boolean;
    }>(`/api/dev/article-discovery-headless-queue${viewParam}`);
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
        cooldownOnlyCount?: number;
        evidenceTargetCount?: number;
        qualifyingHardSourceCount?: number;
        resolvedOrProductiveCount?: number;
      };
    }>("/api/dev/article-discovery-hard-sources");
    hardSources.value = response.report?.hardSources || [];
    hardSourceSummary.value = {
      evidenceTargetCount: response.report?.evidenceTargetCount ?? 0,
      qualifyingHardSourceCount: response.report?.qualifyingHardSourceCount ?? hardSources.value.length,
      cooldownOnlyCount: response.report?.cooldownOnlyCount ?? 0,
      resolvedOrProductiveCount: response.report?.resolvedOrProductiveCount ?? 0,
    };
  } catch (error) {
    console.error("Failed to load hard sources:", error);
    hardSources.value = [];
    hardSourceSummary.value = {
      evidenceTargetCount: 0,
      qualifyingHardSourceCount: 0,
      cooldownOnlyCount: 0,
      resolvedOrProductiveCount: 0,
    };
  } finally {
    hardSourcesLoading.value = false;
  }
};

const reconcileNotificationMarker = async (markerRunId: string, action: 'acknowledge' | 'abandon' = 'acknowledge') => {
  if (reconciliationToken.value !== 'RECONCILE_NOTIFICATION_WORKFLOW_MARKER') return;
  reconciliationLoading.value = true;
  try {
    await $api('/api/dev/notification-workflow-reconcile', { method: 'POST', body: { markerRunId, confirm: true, confirmation: reconciliationToken.value, action } });
    await loadReliabilityDiagnostics();
  } catch (error: any) {
    reliabilityDiagnosticsError.value = error?.data?.statusMessage || error?.message || 'Reconciliation failed.';
  } finally { reconciliationLoading.value = false; }
};

const previewHardSourceRepair = async () => {
  hardSourceRepairLoading.value = true; hardSourceRepairError.value = null;
  try {
    hardSourceRepairResult.value = await $api('/api/dev/hard-source-repair', { method: 'POST', body: { dryRun: true, scanLimit: 200 } });
  } catch (error: any) { hardSourceRepairError.value = error?.data?.statusMessage || error?.message || 'Preview failed.'; }
  finally { hardSourceRepairLoading.value = false; }
};

const confirmHardSourceRepair = async () => {
  if (hardSourceRepairToken.value !== 'REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES') return;
  hardSourceRepairLoading.value = true; hardSourceRepairError.value = null;
  try {
    hardSourceRepairResult.value = await $api('/api/dev/hard-source-repair', { method: 'POST', body: { dryRun: false, confirmation: hardSourceRepairToken.value, scanLimit: 200 } });
    await loadHardSourceProfiles();
  } catch (error: any) { hardSourceRepairError.value = error?.data?.statusMessage || error?.message || 'Repair failed.'; }
  finally { hardSourceRepairLoading.value = false; }
};

const loadReliabilityDiagnostics = async () => {
  if (!showFullDevTools.value) return;
  reliabilityDiagnosticsLoading.value = true;
  reliabilityDiagnosticsError.value = null;
  try {
    reliabilityDiagnostics.value = await $api('/api/dev/notification-and-redirect-diagnostics');
    reliabilityDiagnosticsLoaded.value = true;
  } catch (error: any) {
    reliabilityDiagnosticsError.value = error?.data?.statusMessage || error?.message || 'Failed to load reliability diagnostics.';
  } finally {
    reliabilityDiagnosticsLoading.value = false;
  }
};

const loadHardSourceProfiles = async () => {
  if (!showFullDevTools.value) return;
  hardSourceProfilesLoading.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      profiles: HardSourceProfileEntry[];
      total: number;
    }>("/api/dev/article-discovery-hard-source-profiles");
    hardSourceProfiles.value = response.profiles || [];
  } catch (error) {
    console.error("Failed to load hard source profiles:", error);
    hardSourceProfiles.value = [];
  } finally {
    hardSourceProfilesLoading.value = false;
  }
};

const loadAgent2Health = async () => {
  if (!showFullDevTools.value) return;
  agent2HealthLoading.value = true;
  try {
    const response = await $api<{
      ok: boolean;
      targets: typeof agent2HealthTargets.value;
      total: number;
    }>("/api/dev/agent2-health");
    agent2HealthTargets.value = response.targets || [];
  } catch (error) {
    console.error("Failed to load Agent 2 health:", error);
    agent2HealthTargets.value = [];
  } finally {
    agent2HealthLoading.value = false;
  }
};

const loadDailyPipelineTelemetry = async () => {
  if (!showFullDevTools.value || dailyPipelineTelemetry.value.loading) return;
  dailyPipelineTelemetry.value.loading = true;
  dailyPipelineTelemetry.value.error = null;
  try {
    const response = await $api<any>("/api/dev/daily-pipeline-telemetry");
    dailyPipelineTelemetry.value = { ...response, loading: false, loaded: true, slowestStage: response.stageTimings?.slice().sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0))[0]?.stage || null, stale: response.run?.status === "DAILY_PIPELINE_WORKFLOW_STALE" };
  } catch (error: any) {
    dailyPipelineTelemetry.value.loading = false;
    dailyPipelineTelemetry.value.loaded = true;
    dailyPipelineTelemetry.value.error = error?.statusMessage || error?.message || "Telemetry unavailable.";
  }
};

const releaseDailyPipelineLock = async () => {
  const runId = dailyPipelineTelemetry.value.run?.id;
  if (!runId || dailyLockRecoveryToken.value !== "RELEASE_STALE_DAILY_PIPELINE_LOCK") return;
  dailyLockRecoveryLoading.value = true;
  try {
    const result = await $api<{ changed: boolean; reason: string }>("/api/dev/daily-pipeline-lock-recovery", {
      method: "POST",
      body: { runId, confirmation: dailyLockRecoveryToken.value },
    });
    showToast(result.changed ? "Stale daily pipeline lock released." : `Lock was not released: ${result.reason}.`, result.changed ? "success" : "error");
    dailyLockRecoveryModalOpen.value = false;
    dailyLockRecoveryToken.value = "";
    await loadDailyPipelineTelemetry();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Failed to release stale pipeline lock.", "error");
  } finally {
    dailyLockRecoveryLoading.value = false;
  }
};

const refreshDevPanel = async () => {
  if (!showFullDevTools.value || devPanelRefreshInFlight) return;
  devPanelRefreshInFlight = true;
  try {
    if (isPipelineRunning.value) {
      await Promise.all([
        loadAgent1RunSummary(),
        loadAgent1Progress(),
      ]);
      return;
    }

    await Promise.all([
      loadAgentLogs(),
      loadAgent1RunSummary(),
      loadEligibleSourceCount(),
      loadDiscoveryQuality(),
      loadHeadlessQueue(),
      loadHardSources(),
      loadHardSourceProfiles(),
      loadAgent2Progress(),
      loadAgent1Progress(),
      loadAgent2Health(),
      loadAgent3Progress(),
      loadAgent3RejectionDiagnostics(),
      loadDailyPipelineTelemetry(),
    ]);
  } catch (error) {
    console.error("Failed to refresh admin panel:", error);
  } finally {
    devPanelRefreshInFlight = false;
  }
};

const clearAgentLogs = async () => {
  if (!showFullDevTools.value || !pipelineResetEnabled.value || isClearingLogs.value) return;
  const confirmed = window.confirm(
    "Permanently delete ALL articles, agent logs, pipeline artifacts, and pipeline runs? This cannot be undone.",
  );
  if (!confirmed) return;
  isClearingLogs.value = true;
  try {
    const response = await $api<{ ok: boolean; deletedCount: number; articleCount?: number; artifactCount?: number; runCount?: number }>("/api/dev/agent-logs", {
      method: "DELETE",
      body: { confirmation: "DELETE_ALL_PIPELINE_DATA" },
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
    const response = await $api<{
      ok: boolean;
      processed?: number;
      deferred?: number;
      remainingEligible?: number;
      stoppedReason?: string;
      inserted?: number;
      skipped?: number;
      failed?: number;
      durationMs?: number;
    }>("/api/dev/run-news-pipeline", { method: "POST" });
    const processed = response.processed ?? 0;
    const deferred = response.deferred ?? 0;
    const remaining = response.remainingEligible ?? 0;
    const stoppedReason = response.stoppedReason ?? "completed";
    let msg = `Agent 1 batch: ${processed} processed, ${response.inserted ?? 0} inserted, ${response.skipped ?? 0} skipped, ${response.failed ?? 0} failed.`;
    if (stoppedReason !== "completed") {
      msg += ` stopped: ${stoppedReason}`;
    }
    if (deferred > 0) {
      msg += ` (${remaining} remaining)`;
    }
    showToast(msg, "success", 4000);
    await feedStore.fetchFeed({ force: true });
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Agent 1 batch run failed.", "error");
  } finally {
    isPipelineRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const runArticleDiscovery = async () => {
  if (!showFullDevTools.value || isAgent2BatchDisabled.value) return;
  isArticleDiscoveryRunning.value = true;
  startDevPanelPolling();
  try {
    const response = await $api<{
      ok: boolean;
      agent?: string;
      targetsResolved?: number;
      processed?: number;
      deferred?: number;
      remainingEligible?: number;
      stoppedReason?: string;
      inserted?: number;
      skipped?: number;
      failed?: number;
      candidates?: number;
    }>("/api/dev/run-article-discovery", { method: "POST" });
    const processed = response.processed ?? response.targetsResolved ?? 0;
    const deferred = response.deferred ?? 0;
    const remaining = response.remainingEligible ?? 0;
    const stoppedReason = response.stoppedReason ?? "completed";
    let msg = `Agent 2 batch: ${processed} processed, ${response.inserted ?? 0} inserted, ${response.skipped ?? 0} skipped, ${response.failed ?? 0} failed.`;
    if (stoppedReason !== "completed") {
      msg += ` Stopped: ${stoppedReason}.`;
    }
    if (deferred > 0 || remaining > 0) {
      msg += ` ${deferred} deferred, ${remaining} remaining — run Agent 2 again or wait for next cron.`;
    }
    showToast(msg);
    await feedStore.fetchFeed({ force: true });
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Article discovery failed.", "error");
  } finally {
    isArticleDiscoveryRunning.value = false;
    await refreshDevPanel();
    stopDevPanelPolling();
  }
};

const runAgent3Enrichment = async () => {
  if (!showAdminPipelinePanel.value || isAgent3Running.value) return;
  isAgent3Running.value = true;
  agent3Summary.value = null;
  try {
    const response = await $api<{
      ok: boolean;
      pipelineRunId: string;
      articleCount: number;
      persisted: number;
      failed: number;
      byKind: Record<string, number>;
      artifactCount: number;
      optionsUsed?: { includeEnriched: boolean; forceReprocess: boolean; browserFallback?: boolean };
      browserFallbackStats?: { attempted: number; succeeded: number; failed: number; runtimeUnavailable: number; rateLimited: number } | null;
      successfullyEnriched?: number;
      rejected?: number;
      persistedOutcomes?: number;
      systemPersistFailed?: number;
      progressAfter?: typeof agent3Progress.value;
    }>("/api/dev/run-article-enrichment", {
      method: "POST",
      body: {
        maxArticles: agent3MaxArticles.value,
        includeEnriched: agent3IncludeEnriched.value,
        forceReprocess: agent3ForceReprocess.value,
        browserFallback: agent3BrowserFallback.value,
        browserFallbackMaxAttempts: agent3BrowserFallbackMaxAttempts.value,
        browserTimeoutMs: agent3BrowserTimeoutMs.value,
        maxArticlesPerSource: agent3MaxArticlesPerSource.value,
      },
    });
    agent3Summary.value = response;
    // Update progress from the response if available
    if (response.progressAfter) {
      agent3Progress.value = response.progressAfter;
    } else {
      // Refresh progress from server
      await loadAgent3Progress();
    }
    // Refresh rejection diagnostics after Agent 3 run
    await loadAgent3RejectionDiagnostics();
    const enriched = response.successfullyEnriched ?? response.byKind?.SUCCESS ?? 0;
    const rej = response.rejected ?? response.failed;
    showToast(
      `Agent 3: ${enriched} enriched, ${rej} rejected, ${response.articleCount} processed.`,
      response.ok ? "success" : "error",
    );
  } catch (e: any) {
    showToast(`Agent 3 enrichment failed: ${e?.data?.statusMessage || e?.message || "Unknown error"}`, "error");
  } finally {
    isAgent3Running.value = false;
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

const isRetryableHeadlessStatus = (status: string): boolean => {
  return [
    "BROWSER_NO_CANDIDATES",
    "BROWSER_RUNTIME_UNAVAILABLE",
    "BROWSER_FALLBACK_DISABLED",
    "BROWSER_COOLDOWN_DEFERRED",
    "HEADLESS_PROCESSING_STALE",
    "SKIPPED_UNIMPLEMENTED",
    "INVALID",
  ].includes(status);
};

const isLegacyHeadlessStatus = (status: string): boolean => {
  return ["BROWSER_FALLBACK_DISABLED", "BROWSER_COOLDOWN_DEFERRED"].includes(status);
};

const retryHeadlessQueueItem = async (item: { id: string; targetUrl: string | null; status: string }) => {
  if (!showFullDevTools.value || !canRunManualPipeline.value || retryingHeadlessArtifactId.value) return;
  retryingHeadlessArtifactId.value = item.id;
  try {
    const response = await $api<{
      ok: boolean;
      retryArtifact: { id: string; status: string };
    }>("/api/dev/retry-article-discovery-headless-queue", {
      method: "POST",
      body: {
        artifactId: item.id,
        reason: "manual_admin_retry_after_browser_fallback_change",
      },
    });
    showToast(`Retry queued for ${item.targetUrl || item.id}: ${response.retryArtifact.status}. Run browser fallback to process it.`, "success", 3500);
    await loadHeadlessQueue();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Failed to queue browser retry.", "error");
  } finally {
    retryingHeadlessArtifactId.value = null;
  }
};

/**
 * Compute remaining minutes until a cooldown expires, or null if already expired / invalid.
 */
const cooldownRemainingMinutes = (isoDate: string | null): number | null => {
  if (!isoDate) return null;
  const ms = new Date(isoDate).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 60_000);
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
    case "BROWSER_COOLDOWN_DEFERRED":
      return "bg-amber-500/15 text-amber-400 border-amber-500/20";
    case "SKIPPED_UNIMPLEMENTED":
      return "bg-slate-500/15 text-slate-400 border-slate-500/20";
    case "RESOLVED_BY_STATIC_DISCOVERY":
      return "bg-teal-500/15 text-teal-300 border-teal-500/20";
    default:
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
  }
};

const redirectStatusDescriptor = (redirect: {
  status?: string | null;
  nextRetryAt?: string | null;
  statusDescriptor?: RedirectStatusDescriptor | null;
}): RedirectStatusDescriptor => redirect.statusDescriptor ?? describeRedirectStatus(
  redirect.status || "RETRYABLE",
  redirect.nextRetryAt ?? null,
);

const hardSourceActionLabel = (action: string): string => {
  const labels: Record<string, string> = {
    retry_static: "retry static",
    run_browser: "run browser",
    manual_review: "manual review",
    ai_inspection_candidate: "AI inspection",
    ai_profile_inspection: "AI profile",
    relax_category_scope: "relax scope",
    weak_date_policy_review: "date policy",
    browser_runtime_fix: "fix runtime",
    prefer_listing_links: "prefer listing links",
    use_browser_detail_dates: "use detail dates",
    increase_browser_detail_limit: "increase detail limit",
    respect_cooldown: "respect cooldown",
    mark_unsupported: "mark unsupported",
    needs_ai_inspection: "needs AI inspection",
  };
  return labels[action] || action;
};

const hardSourceActionBadgeClass = (action: string): string => {
  switch (action) {
    case "ai_inspection_candidate":
    case "ai_profile_inspection":
      return "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/20";
    case "run_browser":
    case "browser_runtime_fix":
    case "use_browser_detail_dates":
    case "increase_browser_detail_limit":
      return "bg-sky-500/15 text-sky-300 border-sky-500/20";
    case "retry_static":
    case "relax_category_scope":
    case "prefer_listing_links":
      return "bg-amber-500/15 text-amber-300 border-amber-500/20";
    case "weak_date_policy_review":
      return "bg-orange-500/15 text-orange-300 border-orange-500/20";
    case "respect_cooldown":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/20";
    case "mark_unsupported":
      return "bg-rose-500/15 text-rose-300 border-rose-500/20";
    case "manual_review":
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
    default:
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
  }
};

// ── Maintenance cleanup state + actions ─────────────────────────────────────

const hardSourceLifecycleBadgeClass = (state: string): string => {
  switch (state) {
    case "resolved":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/20";
    case "suggested":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/20";
    case "applied":
      return "bg-blue-500/15 text-blue-300 border-blue-500/20";
    case "ignored":
      return "bg-gray-500/15 text-gray-400 border-gray-500/20";
    case "stale":
      return "bg-amber-500/15 text-amber-300 border-amber-500/20";
    case "open":
    default:
      return "bg-surface-container-highest text-on-surface-variant border-outline-variant/20";
  }
};

const isInspectingOldArticles = ref(false);
const isDeletingOldArticles = ref(false);
const isInspectingArtifacts = ref(false);
const isDeletingArtifacts = ref(false);

// ── Discovery profile activation state ───────────────────────────────────
const activatingProfileId = ref<string | null>(null);
const activatingProfileTargetId = ref<string | null>(null);
const activatingProfileError = ref<string | null>(null);

type ArticleCleanupResult = {
  ok: true;
  dryRun: boolean;
  olderThanDays: number;
  cutoff: string;
  inspected: number;
  eligibleForDeletion: number;
  deleted: number;
  protected: number;
  skipped: number;
  limit: number;
  durationMs: number;
  bySource: Array<{ sourceId: string | null; count: number }>;
  protectedReasons: Record<string, number>;
  skippedReasons: Record<string, number>;
  sampleDeletedOrWouldDelete: Array<{
    id: string;
    url: string | null;
    title: string | null;
    sourceId: string | null;
    publishedAt: string | null;
    createdAt: string;
    effectiveDate: string;
  }>;
};

type PipelineArtifactCleanupResult = {
  ok: true;
  dryRun: boolean;
  olderThanDays: number;
  cutoff: string;
  inspected: number;
  eligibleForDeletion: number;
  deleted: number;
  protected: number;
  skipped: number;
  limit: number;
  durationMs: number;
  byArtifactType: Record<string, number>;
  byStatus: Record<string, number>;
  protectedReasons: Record<string, number>;
  skippedReasons: Record<string, number>;
  sampleDeletedOrWouldDelete: Array<{
    id: string;
    artifactType: string;
    status: string;
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string | null;
    createdAt: string;
    updatedAt: string;
    reason: string;
  }>;
};

const oldArticlesResult = ref<ArticleCleanupResult | null>(null);
const pipelineArtifactsResult = ref<PipelineArtifactCleanupResult | null>(null);

const inspectOldArticles = async () => {
  if (!showFullDevTools.value || isInspectingOldArticles.value) return;
  isInspectingOldArticles.value = true;
  try {
    // Match the existing admin.vue convention (loadHeadlessQueue et al.) of
    // appending query params to the URL string rather than using the `query:`
    // option, even though ofetch supports both.
    const result = await $api<ArticleCleanupResult>(
      "/api/dev/cleanup/articles?olderThanDays=7&limit=100",
    );
    oldArticlesResult.value = result;
    showToast(
      `Inspected: ${result.inspected} found, ${result.eligibleForDeletion} eligible, ${result.protected} protected.`,
      "success",
      4000,
    );
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Article inspection failed.", "error");
  } finally {
    isInspectingOldArticles.value = false;
  }
};

const deleteOldArticles = async () => {
  if (!showFullDevTools.value || !cleanupDeletionEnabled.value || isDeletingOldArticles.value) return;
  const confirmed = window.confirm(
    "Delete eligible old unowned articles? User-saved/favorited/shared articles will be protected.",
  );
  if (!confirmed) return;
  isDeletingOldArticles.value = true;
  try {
    const result = await $api<ArticleCleanupResult>("/api/dev/cleanup/articles", {
      method: "POST",
      body: { dryRun: false, olderThanDays: 7, limit: 100 },
    });
    oldArticlesResult.value = result;
    showToast(
      `Deleted ${result.deleted} old unowned articles. ${result.protected} protected, ${result.skipped} skipped.`,
      "success",
      5000,
    );
    // Refresh agent logs so the cleanup FINISHED log is visible.
    await loadAgentLogs();
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Article deletion failed.", "error");
  } finally {
    isDeletingOldArticles.value = false;
  }
};

const inspectPipelineArtifacts = async () => {
  if (!showFullDevTools.value || isInspectingArtifacts.value) return;
  isInspectingArtifacts.value = true;
  try {
    const result = await $api<PipelineArtifactCleanupResult>(
      "/api/dev/cleanup/pipeline-artifacts?olderThanDays=14&limit=200",
    );
    pipelineArtifactsResult.value = result;
    showToast(
      `Inspected: ${result.inspected} found, ${result.eligibleForDeletion} eligible, ${result.protected} protected.`,
      "success",
      4000,
    );
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Pipeline artifact inspection failed.", "error");
  } finally {
    isInspectingArtifacts.value = false;
  }
};

// ── Discovery profile activation ────────────────────────────────────────

const activateDiscoveryProfile = async (profileId: string, mode: "draft" | "active") => {
  if (activatingProfileId.value) return;
  activatingProfileId.value = profileId;
  activatingProfileTargetId.value = profileId;
  activatingProfileError.value = null;
  try {
    const result = await $api<{
      ok: boolean;
      profileArtifactId: string;
      status: string;
      hardSourceProfileId: string;
    }>("/api/dev/agent2-discovery-profiles/activate", {
      method: "POST",
      body: {
        profileArtifactId: profileId,
        mode,
      },
    });
    showToast(
      `Discovery profile ${result.status} created for hard-source profile.`,
      "success",
      4000,
    );
    await Promise.all([
      loadHardSourceProfiles(),
      loadReliabilityDiagnostics(),
      loadAgent2Health(),
      loadAgentLogs(),
    ]);
  } catch (error: any) {
    const msg = error?.statusMessage || error?.message || "Profile activation failed.";
    activatingProfileError.value = msg;
    showToast(msg, "error", 5000);
  } finally {
    activatingProfileId.value = null;
    activatingProfileTargetId.value = null;
  }
};

const deletePipelineArtifacts = async () => {
  if (!showFullDevTools.value || !cleanupDeletionEnabled.value || isDeletingArtifacts.value) return;
  const confirmed = window.confirm(
    "Delete eligible old pipeline artifacts? Active/in-flight and unresolved hard-source profiles will be protected.",
  );
  if (!confirmed) return;
  isDeletingArtifacts.value = true;
  try {
    const result = await $api<PipelineArtifactCleanupResult>("/api/dev/cleanup/pipeline-artifacts", {
      method: "POST",
      body: { dryRun: false, olderThanDays: 14, limit: 200 },
    });
    pipelineArtifactsResult.value = result;
    showToast(
      `Deleted ${result.deleted} pipeline artifacts. ${result.protected} protected, ${result.skipped} skipped.`,
      "success",
      5000,
    );
    // Refresh relevant admin panels after artifact cleanup.
    await Promise.all([
      loadHeadlessQueue(),
      loadHardSourceProfiles(),
      loadAgentLogs(),
    ]);
  } catch (error: any) {
    showToast(error?.statusMessage || error?.message || "Pipeline artifact deletion failed.", "error");
  } finally {
    isDeletingArtifacts.value = false;
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
      pipelineResetEnabled.value = false;
      cleanupDeletionEnabled.value = false;
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
      pipelineResetEnabled.value = false;
      cleanupDeletionEnabled.value = false;
      canUseFullDevTools.value = false;
      stopDevPanelPolling();
      return;
    }
    void initializeDevPanel();
  },
);
</script>
