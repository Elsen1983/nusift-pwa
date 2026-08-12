import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTICLE_ACCESS_DETECTOR_VERSION,
} from "./article-access-classification";
import {
  persistEnrichmentOutcome,
} from "./enrichment-persist";
import {
  buildHeadlessRequiredOutcome,
  buildSuccessOutcome,
  type ArticleAccessOutcomeSummary,
} from "./enrichment";
import { loadUserFeed } from "../../services/user-feed";
import { isConfirmedBlockingPaywall } from "../../../app/utils/paywall";
import {
  DEFAULT_PAYWALL_REPAIR_LIMIT,
  MAX_PAYWALL_REPAIR_LIMIT,
  PAYWALL_REPAIR_CONFIRMATION,
  PAYWALL_REPAIR_PRODUCTION_CONFIRMATION,
  PAYWALL_REPAIR_ARTIFACT_TYPE,
  assessPaywallRepair,
  formatPaywallRepairReport,
  runPaywallRepair,
  validatePaywallRepairExecution,
  type PaywallRepairArticle,
  type PaywallRepairDb,
} from "./paywall-repair";

const LOCAL_TEST_ENV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://localhost/nusift",
} as const;

const prismaMock = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleUpdateMany: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactCreate: vi.fn(),
  articleFindUnique: vi.fn(),
  claimFindUnique: vi.fn(),
  claimDeleteMany: vi.fn(),
  pipelineRunCreate: vi.fn(),
  pipelineRunUpdate: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {      article: {
        findMany: (...args: unknown[]) => prismaMock.articleFindMany(...args),
        findUnique: (...args: unknown[]) => prismaMock.articleFindUnique(...args),
        updateMany: (...args: unknown[]) => prismaMock.articleUpdateMany(...args),
      },
      articleEnrichmentClaim: {
        findUnique: (...args: unknown[]) => prismaMock.claimFindUnique(...args),
        deleteMany: (...args: unknown[]) => prismaMock.claimDeleteMany(...args),
      },
    pipelineArtifact: {
      findMany: (...args: unknown[]) => prismaMock.artifactFindMany(...args),
      create: (...args: unknown[]) => prismaMock.artifactCreate(...args),
    },
    pipelineRun: {
      create: (...args: unknown[]) => prismaMock.pipelineRunCreate(...args),
      update: (...args: unknown[]) => prismaMock.pipelineRunUpdate(...args),
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      article: {
        findMany: prismaMock.articleFindMany,
        findUnique: prismaMock.articleFindUnique,
        updateMany: prismaMock.articleUpdateMany,
      },
      articleEnrichmentClaim: {
        findUnique: prismaMock.claimFindUnique,
        deleteMany: prismaMock.claimDeleteMany,
      },
      pipelineArtifact: {
        findMany: prismaMock.artifactFindMany,
        create: prismaMock.artifactCreate,
      },
      pipelineRun: {
        create: prismaMock.pipelineRunCreate,
        update: prismaMock.pipelineRunUpdate,
      },
      $transaction: async <T>(nested: (tx: PaywallRepairDb) => Promise<T>) => nested({} as PaywallRepairDb),
    }),
  },
}));

const fullBody = [
  "The Senate approved a sweeping climate and energy bill on Tuesday evening, capping months of negotiations between progressive and moderate lawmakers.",
  "The legislation allocates more than four hundred billion dollars for renewable energy projects, electric vehicle infrastructure, and grid modernization.",
  "Critics argue the compromise waters down emissions targets, while supporters call it the most significant federal action in decades.",
  "The bill now moves to the House, where leadership expects a vote before the summer recess after several months of debate.",
].join("\n\n");

const access = (overrides: Record<string, unknown> = {}) => ({
  classification: "ACCESSIBLE",
  sourceStage: "agent3",
  confidence: "HIGH",
  detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
  evidenceCodes: ["usable_full_body_extracted"],
  contradictingEvidenceCodes: [],
  evidenceArticleScoped: false,
  usableBodyExtracted: true,
  bodyTruncationDetected: false,
  articleScopedGateOrOverlayDetected: false,
  decisive: true,
  previousIsPaywall: true,
  earlyStageClassification: "PAYWALL_BLOCKED",
  earlyStageSource: "agent1",
  earlyStageEvidenceCodes: ["legacy_hint"],
  earlyStageContradictingEvidenceCodes: [],
  finalIsPaywall: false,
  overrideReason: "Agent 3 found a full body.",
  ...overrides,
});

const article = (overrides: Record<string, unknown> = {}): PaywallRepairArticle => ({
  id: 42,
  sourceId: "source-1",
  categoryId: "category-1",
  title: "Accessible analysis",
  canonicalUrl: "https://example.com/story?token=secret&gclid=tracking",
  sourceUrl: "https://example.com/story",
  bodyText: fullBody,
  isPaywall: true,
  enrichmentStatus: "ENRICHED",
  enrichmentOutcome: {
    kind: "SUCCESS",
    access: access(),
  },
  updatedAt: new Date("2026-08-08T10:00:00.000Z"),
  ...overrides,
});

const outcomeArtifact = (overrides: Record<string, unknown> = {}) => ({
  id: "outcome-1",
  sourceId: "source-1",
  categoryId: "category-1",
  artifactType: "article_enrichment_result",
  status: "CAPTURED",
  createdAt: new Date("2026-08-08T09:00:00.000Z"),
  payload: {
    articleId: 42,
    access: access(),
    ...overrides,
  },
});

const configureDb = (rows: PaywallRepairArticle[] = [article()]) => {
  prismaMock.articleFindMany.mockResolvedValue(rows);
  prismaMock.artifactFindMany.mockResolvedValue([outcomeArtifact()]);
  prismaMock.articleUpdateMany.mockResolvedValue({ count: 1 });
  prismaMock.artifactCreate.mockResolvedValue({ id: "repair-artifact-1" });
  prismaMock.pipelineRunCreate.mockResolvedValue({ id: "repair-run-1" });
  prismaMock.pipelineRunUpdate.mockResolvedValue({});
};

const db = (): PaywallRepairDb => ({
  article: {
    findMany: prismaMock.articleFindMany,
    updateMany: prismaMock.articleUpdateMany,
  },
  pipelineArtifact: {
    findMany: prismaMock.artifactFindMany,
    create: prismaMock.artifactCreate,
  },
  pipelineRun: {
    create: prismaMock.pipelineRunCreate,
    update: prismaMock.pipelineRunUpdate,
  },
  $transaction: async (callback) => callback(db()),
});

beforeEach(() => {
  vi.resetAllMocks();
  configureDb();
});

describe("paywall repair execution guards", () => {
  it("defaults to dry-run and clamps the batch limit", () => {
    const result = validatePaywallRepairExecution({ limit: 9999 }, { NODE_ENV: "development" });
    expect(result.apply).toBe(false);
    expect(result.limit).toBe(MAX_PAYWALL_REPAIR_LIMIT);
    expect(DEFAULT_PAYWALL_REPAIR_LIMIT).toBe(100);
  });

  it("rejects apply without the exact confirmation token", () => {
    expect(() => validatePaywallRepairExecution({ apply: true }, { NODE_ENV: "development" }))
      .toThrow(PAYWALL_REPAIR_CONFIRMATION);
  });

  it("rejects an incorrect token", () => {
    expect(() => validatePaywallRepairExecution({ apply: true, confirmation: "wrong" }, { NODE_ENV: "development" }))
      .toThrow(PAYWALL_REPAIR_CONFIRMATION);
  });

  it("rejects production-like environments without explicit production opt-in", () => {
    expect(() => validatePaywallRepairExecution({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION }, {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/nusift",
    })).toThrow(/production/i);
  });

  it("requires the separate production token and opt-in even when --production is explicit", () => {
    expect(() => validatePaywallRepairExecution({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      production: true,
      productionConfirmation: PAYWALL_REPAIR_PRODUCTION_CONFIRMATION,
    }, {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://remote.example/nusift",
      PAYWALL_REPAIR_ALLOW_PRODUCTION: "false",
    })).toThrow(/PAYWALL_REPAIR_ALLOW_PRODUCTION/);
  });
});

describe("paywall repair assessment and execution", () => {
  it("dry-run performs no Article, artifact, or publication writes", async () => {
    const report = await runPaywallRepair({}, db());
    expect(report.dryRun).toBe(true);
    expect(report.likelyFalsePositives).toBe(1);
    expect(report.assessments[0]?.proposedClassification).toBe("ACCESSIBLE");
    expect(report.assessments[0]?.proposedIsPaywall).toBe(false);
    expect(prismaMock.articleUpdateMany).not.toHaveBeenCalled();
    expect(prismaMock.artifactCreate).not.toHaveBeenCalled();
    expect(prismaMock.pipelineRunCreate).not.toHaveBeenCalled();
    expect(formatPaywallRepairReport(report)).not.toContain(fullBody);
  });

  it("repairs only a high-confidence accessible false positive", async () => {
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      limit: 1,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    expect(report.artifactCount).toBe(1);
    expect(prismaMock.articleUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 42, isPaywall: true }),
      data: expect.objectContaining({ isPaywall: false }),
    }));
    const updateData = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(updateData).not.toHaveProperty("publicationStatus");
    expect(updateData).not.toHaveProperty("bodyText");
    expect(updateData).not.toHaveProperty("enrichmentStatus");
    const artifactData = prismaMock.artifactCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(JSON.stringify(artifactData)).not.toContain(fullBody);
    expect(JSON.stringify(artifactData)).not.toContain("secret");
    expect(prismaMock.artifactCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        artifactType: PAYWALL_REPAIR_ARTIFACT_TYPE,
        status: "APPLIED",
      }),
    }));
  });

  it("keeps a genuine article-scoped paywall true", async () => {
    const gated = article({
      bodyText: "Only a short preview is visible.",
      enrichmentOutcome: {
        kind: "PAYWALL_BLOCKED",
        access: access({
          classification: "PAYWALL_BLOCKED",
          confidence: "HIGH",
          evidenceCodes: ["article_scoped_cta", "article_scoped_gate_or_overlay"],
          evidenceArticleScoped: true,
          usableBodyExtracted: false,
          articleScopedGateOrOverlayDetected: true,
          finalIsPaywall: true,
        }),
      },
    });
    configureDb([gated]);
    prismaMock.artifactFindMany.mockResolvedValue([]);
    const report = await runPaywallRepair({}, db());
    expect(report.confirmedBlockingPaywalls).toBe(1);
    expect(report.assessments[0]?.repairEligible).toBe(false);
  });

  it("skips unknown and conflicting evidence", () => {
    const unknown = article({
      enrichmentOutcome: { kind: "SUCCESS", access: access({ classification: "UNKNOWN", confidence: "LOW" }) },
    });
    const conflictingWindow = {
      artifacts: [
        outcomeArtifact({ access: access({ classification: "ACCESSIBLE" }) }),
        { ...outcomeArtifact({ access: access({ classification: "PAYWALL_BLOCKED" }) }), id: "outcome-2", createdAt: new Date("2026-08-08T09:00:00.000Z") },
      ],
      truncated: false,
      queryFailed: false,
    };
    expect(assessPaywallRepair(unknown, { artifacts: [], truncated: false, queryFailed: false }).repairEligible).toBe(false);
    expect(assessPaywallRepair(article({ updatedAt: new Date("2026-08-08T09:00:00.000Z") }), conflictingWindow).repairEligible).toBe(false);
  });

  it("never authorizes repair from Agent 1 or Agent 2 access evidence", () => {
    for (const sourceStage of ["agent1", "agent2"] as const) {
      const earlyOnly = article({
        enrichmentOutcome: {
          kind: "SUCCESS",
          access: access({ sourceStage }),
        },
      });
      const earlyArtifact = outcomeArtifact({
        access: access({ sourceStage }),
      });
      const assessment = assessPaywallRepair(earlyOnly, {
        artifacts: [earlyArtifact],
        truncated: false,
        queryFailed: false,
      });
      expect(assessment.repairEligible).toBe(false);
      expect(assessment.decision).toBe("SKIPPED");
      expect(assessment.reason).toContain("Automatic repair requires authoritative Agent 3 access evidence.");
    }
  });

  it("uses valid Agent 3 Article-summary evidence as fallback when no exact artifact exists", () => {
    const assessment = assessPaywallRepair(article(), {
      artifacts: [],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.selectedEvidenceSource).toBe("article_outcome");
    expect(assessment.selectedEvidenceArtifactId).toBeNull();
  });

  it("does not let a recently updated Article summary override an exact blocking Agent 3 artifact", () => {
    const staleSummary = article({
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
      enrichmentOutcome: {
        kind: "SUCCESS",
        access: access({ evidenceCodes: ["stale_article_summary"] }),
      },
    });
    const blockingArtifact = {
      ...outcomeArtifact({
        access: access({
          classification: "PAYWALL_BLOCKED",
          confidence: "HIGH",
          evidenceCodes: ["article_scoped_cta", "article_scoped_gate_or_overlay"],
          evidenceArticleScoped: true,
          usableBodyExtracted: false,
          articleScopedGateOrOverlayDetected: true,
        }),
      }),
      id: "blocking-agent3-artifact",
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
    };
    const assessment = assessPaywallRepair(staleSummary, {
      artifacts: [blockingArtifact],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.selectedEvidenceArtifactId).toBe("blocking-agent3-artifact");
    expect(assessment.currentClassification).toBe("PAYWALL_BLOCKED");
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("CONFIRMED_BLOCKING_PAYWALL");
  });

  it("selects the newer exact Agent 3 artifact without using Article.updatedAt", () => {
    const older = {
      ...outcomeArtifact({ access: access({ evidenceCodes: ["older-agent3"] }) }),
      id: "agent3-older",
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
    };
    const newer = {
      ...outcomeArtifact({ access: access({ evidenceCodes: ["newer-agent3"] }) }),
      id: "agent3-newer",
      createdAt: new Date("2026-08-08T10:00:00.000Z"),
    };
    const assessment = assessPaywallRepair(article({ updatedAt: new Date("2026-08-08T08:00:00.000Z") }), {
      artifacts: [older, newer],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.selectedEvidenceArtifactId).toBe("agent3-newer");
    expect(assessment.evidenceCodes).toEqual(["newer-agent3"]);
    expect(assessment.repairEligible).toBe(true);
  });

  it("fails closed for equal-timestamp contradictory Agent 3 artifacts", () => {
    const timestamp = new Date("2026-08-08T09:00:00.000Z");
    const accessible = { ...outcomeArtifact({ access: access({ classification: "ACCESSIBLE" }) }), id: "agent3-a", createdAt: timestamp };
    const blocked = { ...outcomeArtifact({ access: access({ classification: "PAYWALL_BLOCKED", evidenceCodes: ["article_scoped_cta"], evidenceArticleScoped: true, usableBodyExtracted: false }) }), id: "agent3-b", createdAt: timestamp };
    const assessment = assessPaywallRepair(article(), {
      artifacts: [accessible, blocked],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("SKIPPED");
    expect(assessment.reason).toContain("Conflicting Agent 3 evidence exists at the newest artifact timestamp");
  });

  it("fails closed when the exact artifact history is truncated", () => {
    const assessment = assessPaywallRepair(article(), {
      artifacts: [outcomeArtifact({ access: access({ evidenceCodes: ["agent3-evidence"] }) })],
      truncated: true,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("SKIPPED");
    expect(assessment.reason).toContain("Automatic repair criteria were not all satisfied.");
  });

  it("covers HEADLESS_REQUIRED queue persistence followed by browser-recovery SUCCESS repair assessment", async () => {
    const provenance = {
      sourceId: "source-1",
      categoryId: "category-1",
      feedOrigin: "rss" as const,
      feedUrl: "https://example.com/feed",
      discoveredFromCategoryFeed: false,
      arrivedViaHardCaseRerun: false,
      ingestedAt: "2026-08-08T08:00:00.000Z",
    };
    const headlessOutcome = buildHeadlessRequiredOutcome({
      articleId: 42,
      articleUrl: "https://example.com/story",
      provenance,
      detail: "Client-rendered article requires browser recovery.",
    });
    const recoveredOutcome = buildSuccessOutcome({
      articleId: 42,
      articleUrl: "https://example.com/story",
      provenance,
      method: { method: "browser-dom", detail: "browser recovery" },
      fields: { bodyText: { raw: null, chosenValue: fullBody, chosenFrom: "dom", overrideReason: "browser recovery" } },
      access: access({ evidenceCodes: ["browser_recovery_full_body"] }) as ArticleAccessOutcomeSummary,
    });
    // Exercise the maintained transactional Agent 3 persistence boundary for
    // both lifecycle transitions, rather than treating artifact-builder output
    // as if it had already been persisted.
    const persistedArtifactCreates: Array<Record<string, unknown>> = [];
    const activeClaims = new Set(["claim-headless", "claim-recovered"]);
    prismaMock.claimFindUnique.mockImplementation(async (args: { where?: { token?: string } }) => {
      const token = args.where?.token ?? "";
      if (!activeClaims.has(token)) return null;
      return {
        articleId: 42,
        pipelineRunId: "run-1",
        token,
        attemptNumber: token === "claim-headless" ? 1 : 2,
        expectedStatus: token === "claim-headless" ? "INGESTED" : "ENRICHMENT_QUEUED_HEADLESS",
        expiresAt: new Date(Date.now() + 60_000),
      };
    });
    prismaMock.claimDeleteMany.mockImplementation(async (args: { where?: { token?: string } }) => {
      const token = args.where?.token ?? "";
      if (!activeClaims.delete(token)) return { count: 0 };
      return { count: 1 };
    });
    prismaMock.articleFindUnique.mockResolvedValue({
      bodyText: fullBody,
      title: "Accessible analysis",
      canonicalUrl: "https://example.com/story",
    });
    prismaMock.articleUpdateMany.mockResolvedValue({ count: 1 });
    prismaMock.artifactCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      persistedArtifactCreates.push(args.data);
      return { id: `persisted-${persistedArtifactCreates.length}` };
    });

    const headlessPersistence = await persistEnrichmentOutcome(headlessOutcome, "run-1", "claim-headless");
    const recoveredPersistence = await persistEnrichmentOutcome(recoveredOutcome, "run-1", "claim-recovered");
    expect(headlessPersistence).toEqual({ artifactId: "persisted-1", applied: true, claimLost: false, madePublishable: false });
    expect(recoveredPersistence).toEqual({ artifactId: "persisted-2", applied: true, claimLost: false, madePublishable: true });
    expect(prismaMock.articleUpdateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.claimDeleteMany).toHaveBeenCalledTimes(2);
    expect(activeClaims).toEqual(new Set());
    expect(prismaMock.artifactCreate).toHaveBeenCalledTimes(2);
    expect(persistedArtifactCreates).toHaveLength(2);
    expect(persistedArtifactCreates.map((data) => data.artifactType)).toEqual([
      "article_headless_queue_candidate",
      "article_enrichment_result",
    ]);
    expect(prismaMock.articleUpdateMany.mock.calls.map((call) => call[0]?.data?.enrichmentStatus)).toEqual([
      "ENRICHMENT_QUEUED_HEADLESS",
      "ENRICHED",
    ]);

    const persistedArtifact = (data: Record<string, unknown>, id: string, createdAt: string) => ({
      id,
      sourceId: data.sourceId as string,
      categoryId: data.categoryId as string | null,
      artifactType: data.artifactType as string,
      status: data.status as string,
      createdAt: new Date(createdAt),
      payload: data.payload,
    });
    // The repair scan reads the exact payloads captured from the real
    // persistence calls, with only database identity/timestamps supplied by
    // this isolated fixture.
    const headlessQueueArtifact = persistedArtifact(persistedArtifactCreates[0]!, "persisted-1", "2026-08-08T08:00:00.000Z");
    const recoveredResult = persistedArtifact(persistedArtifactCreates[1]!, "persisted-2", "2026-08-08T09:00:00.000Z");

    configureDb([article()]);
    prismaMock.artifactFindMany.mockResolvedValue([headlessQueueArtifact, recoveredResult]);
    prismaMock.articleUpdateMany.mockClear();
    prismaMock.artifactCreate.mockClear();
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(headlessQueueArtifact.artifactType).toBe("article_headless_queue_candidate");
    expect(recoveredResult.artifactType).toBe("article_enrichment_result");
    expect(report.appliedCount).toBe(1);
    expect(report.assessments[0]?.selectedEvidenceArtifactId).toBe("persisted-2");
    expect(prismaMock.articleUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.artifactCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps valid Agent 3 authority despite an older queue artifact with null access", () => {
    const assessment = assessPaywallRepair(article(), {
      artifacts: [
        {
          ...outcomeArtifact({ access: null }),
          artifactType: "article_headless_queue_candidate",
          id: "older-headless-null",
          createdAt: new Date("2026-08-08T08:00:00.000Z"),
        },
        outcomeArtifact({ access: access({ evidenceCodes: ["authoritative-success"] }) }),
      ],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.selectedEvidenceArtifactId).toBe("outcome-1");
  });

  it("keeps valid Agent 3 authority despite a queue artifact with no access property", () => {
    const queueArtifact = {
      ...outcomeArtifact(),
      artifactType: "article_headless_queue_candidate",
      id: "headless-missing-access",
      payload: { articleId: 42, kind: "HEADLESS_REQUIRED" },
    };
    const assessment = assessPaywallRepair(article(), {
      artifacts: [queueArtifact, outcomeArtifact()],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.selectedEvidenceArtifactId).toBe("outcome-1");
  });

  it("allows the Agent 3 Article-summary fallback with a null-access queue artifact", () => {
    const queueArtifact = {
      ...outcomeArtifact({ access: null }),
      artifactType: "article_headless_queue_candidate",
      id: "headless-null-fallback",
    };
    const assessment = assessPaywallRepair(article(), {
      artifacts: [queueArtifact],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.selectedEvidenceSource).toBe("article_outcome");
  });

  it("ignores malformed queue access without treating it as malformed authority", () => {
    const queueArtifact = {
      ...outcomeArtifact({ access: { classification: "ACCESSIBLE", raw: "<html>" } }),
      artifactType: "article_headless_queue_candidate",
      id: "headless-malformed-access",
    };
    const assessment = assessPaywallRepair(article(), {
      artifacts: [queueArtifact],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.selectedEvidenceSource).toBe("article_outcome");
  });

  it("does not let non-enrichment Agent 3 artifacts authorize repair", () => {
    const earlyOnly = article({ enrichmentOutcome: { kind: "SUCCESS", access: access({ sourceStage: "agent2" }) } });
    const queueArtifact = {
      ...outcomeArtifact({ access: access({ sourceStage: "agent3", evidenceCodes: ["queue_candidate"] }) }),
      artifactType: "article_headless_queue_candidate",
      id: "queue-agent3-artifact",
    };
    const assessment = assessPaywallRepair(earlyOnly, {
      artifacts: [queueArtifact],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.selectedEvidenceSource).toBeNull();
    expect(assessment.diagnosticArtifactId).toBe("queue-agent3-artifact");
    expect(assessment.reason).toContain("Automatic repair requires authoritative Agent 3 access evidence.");
  });

  it("serializes non-authoritative artifact diagnostics without granting repair authority", async () => {
    const earlyArtifact = {
      ...outcomeArtifact({
        access: access({ sourceStage: "agent2", evidenceCodes: ["agent2_hint"] }),
      }),
      id: "agent2-diagnostic-artifact",
    };
    configureDb([article()]);
    prismaMock.artifactFindMany.mockResolvedValue([earlyArtifact]);
    const report = await runPaywallRepair({ environment: { NODE_ENV: "development" } }, db());
    expect(report.assessments[0]?.repairEligible).toBe(true);
    const serialized = JSON.parse(formatPaywallRepairReport(report)) as {
      samples: Array<{
        diagnosticSourceStage: string | null;
        diagnosticArtifactId: string | null;
        diagnosticEvidenceCodes: string[];
      }>;
    };
    expect(serialized.samples[0]).toMatchObject({
      diagnosticSourceStage: "agent2",
      diagnosticArtifactId: "agent2-diagnostic-artifact",
      diagnosticEvidenceCodes: ["agent2_hint"],
    });
  });

  it("does not update or create a repair artifact for non-authoritative skipped evidence", async () => {
    const earlyOnly = article({ enrichmentOutcome: { kind: "SUCCESS", access: access({ sourceStage: "agent2" }) } });
    configureDb([earlyOnly]);
    prismaMock.artifactFindMany.mockResolvedValue([]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(0);
    expect(report.skippedCases).toBe(1);
    expect(prismaMock.articleUpdateMany).not.toHaveBeenCalled();
    expect(prismaMock.artifactCreate).not.toHaveBeenCalled();
    const serialized = formatPaywallRepairReport(report);
    expect(serialized).toContain('"diagnosticSourceStage": "agent2"');
    expect(serialized).toContain('"diagnosticArtifactId": null');
  });

  it("fails closed for malformed exact article_enrichment_result evidence", () => {
    const malformedArtifact = outcomeArtifact({ access: { classification: "ACCESSIBLE", evidenceCodes: ["<raw>"] } });
    const assessment = assessPaywallRepair(article(), {
      artifacts: [{ ...malformedArtifact, payload: { articleId: 42, access: { classification: "ACCESSIBLE", evidenceCodes: ["<html>raw</html>"] } } }],
      truncated: false,
      queryFailed: false,
      malformedEvidenceArticleIds: new Set([42]),
    });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("SKIPPED");
  });

  it("fails closed for malformed exact article_enrichment_rejection evidence", () => {
    const malformedRejection = {
      ...outcomeArtifact({ access: null }),
      artifactType: "article_enrichment_rejection",
      id: "malformed-rejection",
      payload: { articleId: 42, kind: "LOW_CONTENT_QUALITY", access: null },
    };
    const assessment = assessPaywallRepair(article(), {
      artifacts: [malformedRejection],
      truncated: false,
      queryFailed: false,
    });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("SKIPPED");
  });

  it("runPaywallRepair skips malformed exact Agent 3 evidence without writes", async () => {
    configureDb([article()]);
    prismaMock.artifactFindMany.mockResolvedValue([{
      ...outcomeArtifact(),
      payload: {
        articleId: 42,
        access: { classification: "ACCESSIBLE", sourceStage: "agent3" },
      },
    }]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(0);
    expect(report.skippedCases).toBe(1);
    expect(prismaMock.articleUpdateMany).not.toHaveBeenCalled();
    expect(prismaMock.artifactCreate).not.toHaveBeenCalled();
  });

  it("fails closed for a stale PAYWALL_BLOCKED outcome instead of creating an inconsistent transition", () => {
    const stale = article({
      enrichmentOutcome: { kind: "PAYWALL_BLOCKED", access: access({ classification: "ACCESSIBLE", evidenceCodes: [], articleScopedGateOrOverlayDetected: false }) },
    });
    const assessment = assessPaywallRepair(stale, { artifacts: [], truncated: false, queryFailed: false });
    expect(assessment.repairEligible).toBe(false);
    expect(assessment.decision).toBe("SKIPPED");
    expect(assessment.proposedIsPaywall).toBe(true);
  });

  it("supports a partially successful Agent 3 extraction only when the stored body is substantial", () => {
    const partial = article({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: { kind: "LOW_CONTENT_QUALITY", access: access() },
    });
    const assessment = assessPaywallRepair(partial, { artifacts: [], truncated: false, queryFailed: false });
    expect(assessment.repairEligible).toBe(true);

    const malformed = article({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: { kind: "LOW_CONTENT_QUALITY" },
    });
    expect(assessPaywallRepair(malformed, { artifacts: [], truncated: false, queryFailed: false }).repairEligible).toBe(false);
  });

  it("preserves LOW_CONTENT_QUALITY state and bounded rejection/retry diagnostics during apply", async () => {
    const partial = article({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        kind: "LOW_CONTENT_QUALITY",
        extractorVersion: "a3-original-version",
        method: "http-dom",
        confidence: 0.41,
        rejectionCode: "LOW_CONTENT_QUALITY",
        rejectionDetail: "short but retained diagnostic",
        retryAfterAt: "2026-08-09T12:00:00.000Z",
        error: "bounded diagnostic error",
        rejectionDiagnostics: { bodyText: fullBody, bodyRejectedReason: "short_body" },
        retryDiagnostics: { disposition: "READY_RETRY", attemptNumber: 2, evidenceSummary: "retryable" },
        browserFallback: { attempted: true, succeeded: false, runtimeUnavailable: true },
        provenance: { sourceId: "source-1", feedOrigin: "rss", ingestArtifactId: "ingest-1" },
        access: access({ detectorVersion: "article-access-v1.0.0" }),
      },
    });
    configureDb([partial]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    expect(report.artifactCount).toBe(1);
    const updateData = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(updateData.isPaywall).toBe(false);
    expect(updateData.enrichmentStatus).toBeUndefined();
    const repaired = updateData.enrichmentOutcome as Record<string, unknown>;
    expect(repaired.kind).toBe("LOW_CONTENT_QUALITY");
    expect(repaired.extractorVersion).toBe("a3-original-version");
    expect(repaired.rejectionCode).toBe("LOW_CONTENT_QUALITY");
    expect(repaired.rejectionDetail).toBe("short but retained diagnostic");
    expect(repaired.retryAfterAt).toBe("2026-08-09T12:00:00.000Z");
    expect(repaired.error).toBe("bounded diagnostic error");
    expect(repaired.rejectionDiagnostics).toEqual({ bodyRejectedReason: "short_body" });
    expect(repaired.retryDiagnostics).toEqual({ disposition: "READY_RETRY", attemptNumber: 2, evidenceSummary: "retryable" });
    expect(repaired.browserFallback).toEqual(expect.objectContaining({ attempted: true, succeeded: false, runtimeUnavailable: true }));
    expect((repaired.access as Record<string, unknown>).classification).toBe("ACCESSIBLE");
    expect((repaired.access as Record<string, unknown>).finalIsPaywall).toBe(false);
    expect((repaired.paywallRepair as Record<string, unknown>).previousOutcomeKind).toBe("LOW_CONTENT_QUALITY");
    expect((repaired.paywallRepair as Record<string, unknown>).enrichmentStatusAtRepair).toBe("ENRICHMENT_FAILED");
    expect((prismaMock.artifactCreate.mock.calls[0]?.[0]?.data?.payload as Record<string, unknown>).previousOutcomeKind).toBe("LOW_CONTENT_QUALITY");
  });

  it("preserves SUCCESS method, confidence, provenance, recovery, browser diagnostics, and content state", async () => {
    const successful = article({
      enrichmentOutcome: {
        kind: "SUCCESS",
        extractorVersion: "a3-original-version",
        method: "browser-dom",
        confidence: 0.93,
        provenance: {
          sourceId: "source-1",
          feedOrigin: "rss",
          ingestArtifactId: "ingest-9",
          earlyAccessRecovery: {
            status: "MATCHED",
            artifactTypesQueried: ["rss_candidates", "article_discovery_candidates"],
            artifactsScanned: 3,
            artifactWindowLimit: 200,
            candidateLimitPerArtifact: 100,
            matchingArtifactType: "article_discovery_candidates",
            matchingArtifactId: "discovery-1",
            candidateMatchType: "canonical",
            windowTruncated: false,
          },
        },
        browserFallback: { attempted: true, succeeded: true, runtimeUnavailable: false },
        access: access({
          earlyStageSource: "agent2",
          earlyStageClassification: "METERED_OR_DECLARED",
          earlyStageEvidenceCodes: ["jsonld_declared_paywall"],
          detectorVersion: "article-access-v1.0.0",
        }),
      },
    });
    configureDb([successful]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    const updateData = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    const repaired = updateData.enrichmentOutcome as Record<string, unknown>;
    expect(repaired.kind).toBe("SUCCESS");
    expect(updateData.isPaywall).toBe(false);
    expect(repaired.method).toBe("browser-dom");
    expect(repaired.confidence).toBe(0.93);
    expect(repaired.provenance).toEqual(expect.objectContaining({
      sourceId: "source-1",
      feedOrigin: "rss",
      ingestArtifactId: "ingest-9",
      earlyAccessRecovery: expect.objectContaining({ matchingArtifactId: "discovery-1" }),
    }));
    expect(repaired.browserFallback).toEqual(expect.objectContaining({ attempted: true, succeeded: true, runtimeUnavailable: false }));
    expect((repaired.access as Record<string, unknown>).earlyStageSource).toBe("agent1");
    expect(updateData.bodyText).toBeUndefined();
    expect(updateData.publicationStatus).toBeUndefined();
  });

  it("does not substitute an access detector version for a missing or malformed extractor version", async () => {
    const missingExtractor = article({
      enrichmentOutcome: {
        kind: "SUCCESS",
        access: access({ detectorVersion: "article-access-v1.0.0" }),
      },
    });
    configureDb([missingExtractor]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    expect(missingExtractor.enrichmentStatus).toBe("ENRICHED");
    const missingUpdateData = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(missingUpdateData.enrichmentStatus).toBeUndefined();
    const repaired = missingUpdateData.enrichmentOutcome as Record<string, unknown>;
    expect(repaired).not.toHaveProperty("extractorVersion");
    expect(repaired.kind).toBe("SUCCESS");
    expect(repaired.extractorVersion).toBeUndefined();
    expect((repaired.access as Record<string, unknown>).detectorVersion).toBe(ARTICLE_ACCESS_DETECTOR_VERSION);

    const malformedExtractor = article({
      enrichmentOutcome: {
        kind: "SUCCESS",
        extractorVersion: "<raw-detector-version>",
        access: access({ detectorVersion: "article-access-v1.0.0" }),
      },
    });
    configureDb([malformedExtractor]);
    const malformedReport = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(malformedReport.appliedCount).toBe(1);
    const sanitized = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data?.enrichmentOutcome as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty("extractorVersion");
    expect((sanitized.access as Record<string, unknown>).detectorVersion).toBe(ARTICLE_ACCESS_DETECTOR_VERSION);
  });

  it("uses the newer artifact snapshot consistently in both durable repair records", async () => {
    const olderArticle = article({
      updatedAt: new Date("2026-08-08T08:00:00.000Z"),
      enrichmentOutcome: {
        kind: "SUCCESS",
        extractorVersion: "a3-original-version",
        access: access({
          detectorVersion: "article-access-v1.0.0",
          evidenceCodes: ["older_article_summary"],
        }),
      },
    });
    const newerArtifact = {
      ...outcomeArtifact({
        access: access({
          detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
          evidenceCodes: ["newer_artifact_evidence"],
        }),
      }),
      id: "newer-evidence-artifact",
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
    };
    configureDb([olderArticle]);
    prismaMock.artifactFindMany.mockResolvedValue([newerArtifact]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    expect(report.assessments[0]?.selectedEvidenceSource).toBe("artifact");
    expect(report.assessments[0]?.selectedEvidenceArtifactId).toBe("newer-evidence-artifact");

    const repaired = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data?.enrichmentOutcome as Record<string, unknown>;
    const articleRepair = repaired.paywallRepair as Record<string, unknown>;
    const artifactPayload = prismaMock.artifactCreate.mock.calls[0]?.[0]?.data?.payload as Record<string, unknown>;
    expect(articleRepair.previousClassification).toBe("ACCESSIBLE");
    expect(articleRepair.selectedEvidenceClassification).toBe("ACCESSIBLE");
    expect(articleRepair.selectedEvidenceCodes).toEqual(["newer_artifact_evidence"]);
    expect(articleRepair.selectedEvidenceContradictingEvidenceCodes).toEqual([]);
    expect(articleRepair.previousDetectorVersion).toBe(ARTICLE_ACCESS_DETECTOR_VERSION);
    expect(articleRepair.selectedEvidenceDetectorVersion).toBe(ARTICLE_ACCESS_DETECTOR_VERSION);
    expect(articleRepair.articleSummaryDetectorVersion).toBe("article-access-v1.0.0");
    expect(articleRepair.selectedEvidenceSource).toBe("artifact");
    expect(articleRepair.selectedEvidenceArtifactId).toBe("newer-evidence-artifact");
    expect(artifactPayload.previousClassification).toBe(articleRepair.previousClassification);
    expect(artifactPayload.selectedEvidenceClassification).toBe(articleRepair.selectedEvidenceClassification);
    expect(artifactPayload.selectedEvidenceCodes).toEqual(articleRepair.selectedEvidenceCodes);
    expect(artifactPayload.selectedEvidenceContradictingEvidenceCodes).toEqual(articleRepair.selectedEvidenceContradictingEvidenceCodes);
    expect(artifactPayload.previousDetectorVersion).toBe(articleRepair.previousDetectorVersion);
    expect(artifactPayload.selectedEvidenceDetectorVersion).toBe(articleRepair.selectedEvidenceDetectorVersion);
    expect(artifactPayload.selectedEvidenceSource).toBe(articleRepair.selectedEvidenceSource);
    expect(artifactPayload.selectedEvidenceArtifactId).toBe(articleRepair.selectedEvidenceArtifactId);
    expect(artifactPayload.evidenceCodes).toEqual((repaired.access as Record<string, unknown>).evidenceCodes);
    expect(artifactPayload.contradictingEvidenceCodes).toEqual((repaired.access as Record<string, unknown>).contradictingEvidenceCodes);
    expect(artifactPayload.repairTimestamp).toBe(articleRepair.repairTimestamp);
  });

  it("uses the Article summary as selected evidence when no artifact snapshot exists", async () => {
    const articleSummary = article({
      enrichmentOutcome: {
        kind: "SUCCESS",
        access: access({ detectorVersion: "article-access-v1.0.0", evidenceCodes: ["article_summary_evidence"] }),
      },
    });
    configureDb([articleSummary]);
    prismaMock.artifactFindMany.mockResolvedValue([]);
    const report = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(report.appliedCount).toBe(1);
    expect(report.assessments[0]?.selectedEvidenceSource).toBe("article_outcome");
    expect(report.assessments[0]?.selectedEvidenceArtifactId).toBeNull();
    const repaired = prismaMock.articleUpdateMany.mock.calls[0]?.[0]?.data?.enrichmentOutcome as Record<string, unknown>;
    const articleRepair = repaired.paywallRepair as Record<string, unknown>;
    const artifactPayload = prismaMock.artifactCreate.mock.calls[0]?.[0]?.data?.payload as Record<string, unknown>;
    expect(articleRepair.selectedEvidenceSource).toBe("article_outcome");
    expect(articleRepair.selectedEvidenceArtifactId).toBeNull();
    expect(articleRepair.previousDetectorVersion).toBe("article-access-v1.0.0");
    expect(articleRepair.selectedEvidenceClassification).toBe("ACCESSIBLE");
    expect(articleRepair.selectedEvidenceCodes).toEqual(["article_summary_evidence"]);
    expect(artifactPayload.selectedEvidenceSource).toBe("article_outcome");
    expect(artifactPayload.selectedEvidenceArtifactId).toBeNull();
    expect(artifactPayload.previousDetectorVersion).toBe(articleRepair.previousDetectorVersion);
    expect(artifactPayload.selectedEvidenceClassification).toBe(articleRepair.selectedEvidenceClassification);
    expect(artifactPayload.selectedEvidenceCodes).toEqual(articleRepair.selectedEvidenceCodes);
    expect(artifactPayload.selectedEvidenceContradictingEvidenceCodes).toEqual(articleRepair.selectedEvidenceContradictingEvidenceCodes);
    expect(artifactPayload.repairTimestamp).toBe(articleRepair.repairTimestamp);
  });

  it("counts each truncated source once while reporting article-level telemetry separately", async () => {
    const sourceA = article({ id: 1, sourceId: "source-a" });
    const sourceA2 = article({ id: 2, sourceId: "source-a" });
    const sourceB = article({ id: 3, sourceId: "source-b" });
    configureDb([sourceA, sourceA2, sourceB]);
    prismaMock.artifactFindMany.mockImplementation(async (args: { where?: { sourceId?: string } }) => {
      if (args.where?.sourceId === "source-a") {
        return Array.from({ length: 201 }, (_, index) => ({
          ...outcomeArtifact(),
          id: `noise-${index}`,
          sourceId: "source-a",
          payload: { articleId: 999_000 + index, access: access() },
        }));
      }
      return [{ ...outcomeArtifact(), sourceId: "source-b", payload: { articleId: 3, access: access() } }];
    });
    const report = await runPaywallRepair({ environment: { NODE_ENV: "development" } }, db());
    expect(report.truncatedSourceCount).toBe(1);
    expect(report.articlesFromTruncatedSources).toBe(2);
    expect(report.bySource["source-b"]?.inspected).toBe(1);
  });

  it("fails closed when the Article changed concurrently", async () => {
    prismaMock.articleUpdateMany.mockResolvedValue({ count: 0 });
    const report = await runPaywallRepair({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION, environment: LOCAL_TEST_ENV }, db());
    expect(report.appliedCount).toBe(0);
    expect(report.concurrentChangeCount).toBe(1);
    expect(report.artifactCount).toBe(0);
    expect(prismaMock.artifactCreate).not.toHaveBeenCalled();
  });

  it("serializes a report without body text or raw enrichment outcome", () => {
    const report = {
      dryRun: true,
      applyRequested: false,
      inspectedCount: 1,
      likelyFalsePositives: 0,
      confirmedBlockingPaywalls: 0,
      declaredMeteredCases: 0,
      unknownCases: 0,
      skippedCases: 1,
      detectorVersionMismatchCount: 0,
      truncatedSourceCount: 0,
      articlesFromTruncatedSources: 0,
      appliedCount: 0,
      concurrentChangeCount: 0,
      failedCount: 0,
      artifactCount: 0,
      bySource: {},
      samples: [],
      assessments: [{
        ...assessPaywallRepair(article(), { artifacts: [], truncated: false, queryFailed: false }),
      }],
    };
    const serialized = formatPaywallRepairReport(report);
    expect(serialized).not.toContain(fullBody);
    expect(serialized).not.toContain("enrichmentOutcome");
  });

  it("prevents a same-process concurrent duplicate apply", async () => {
    const release = { fn: null as (() => void) | null };
    const updateBlocked = new Promise<void>((resolve) => { release.fn = resolve; });
    prismaMock.articleUpdateMany.mockImplementation(async () => {
      await updateBlocked;
      return { count: 1 };
    });
    const first = runPaywallRepair({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION, environment: LOCAL_TEST_ENV }, db());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await runPaywallRepair({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION, environment: LOCAL_TEST_ENV }, db());
    expect(second.appliedCount).toBe(0);
    expect(second.concurrentChangeCount).toBe(1);
    release.fn?.();
    expect((await first).appliedCount).toBe(1);
  });

  it("fails closed in a clean environment, while dry-run remains write-free", async () => {
    expect(() => validatePaywallRepairExecution({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
    }, { NODE_ENV: "development" })).toThrow(/DATABASE_URL/);

    const dryRun = await runPaywallRepair({ environment: { NODE_ENV: "development" } }, db());
    expect(dryRun.dryRun).toBe(true);
    expect(prismaMock.articleUpdateMany).not.toHaveBeenCalled();
    expect(prismaMock.artifactCreate).not.toHaveBeenCalled();

    const applied = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, db());
    expect(applied.appliedCount).toBe(1);
  });

  it("is idempotent when the second scan no longer finds isPaywall=true", async () => {
    const first = await runPaywallRepair({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION, environment: LOCAL_TEST_ENV }, db());
    expect(first.appliedCount).toBe(1);
    prismaMock.articleFindMany.mockResolvedValue([]);
    const second = await runPaywallRepair({ apply: true, confirmation: PAYWALL_REPAIR_CONFIRMATION, environment: LOCAL_TEST_ENV }, db());
    expect(second.inspectedCount).toBe(0);
    expect(second.appliedCount).toBe(0);
  });

  it("proves the durable repair transition through loadUserFeed and the public blocking helper", async () => {
    const durableArticle = {
      ...article(),
      date: new Date("2026-08-08T10:00:00.000Z"),
      score: 5,
      tags: [],
      signals: [],
      reasoning: null,
      publicationStatus: "PUBLISHED",
      publicationStage: "agent3",
      publicationReadyAt: new Date("2026-08-08T10:01:00.000Z"),
      source: { frontPageUrl: "https://example.com", mediaName: "Example" },
      category: null,
    } as PaywallRepairArticle & Record<string, unknown>;
    const durableRepairArtifacts: unknown[] = [];
    let exactArticleUpdate: Record<string, unknown> | null = null;
    const repairDb: PaywallRepairDb = {
      article: {
        findMany: async () => durableArticle.isPaywall ? [durableArticle] : [],
        updateMany: async (args: any) => {
          expect(args.where).toMatchObject({ id: durableArticle.id, isPaywall: true, updatedAt: durableArticle.updatedAt });
          exactArticleUpdate = args.data;
          durableArticle.isPaywall = false;
          durableArticle.enrichmentOutcome = args.data.enrichmentOutcome;
          return { count: 1 };
        },
      },
      pipelineArtifact: {
        findMany: async () => [],
        create: async (args: any) => {
          durableRepairArtifacts.push(args.data);
          return { id: "repair-artifact-durable" };
        },
      },
      pipelineRun: {
        create: async () => ({ id: "repair-run-durable" }),
        update: async () => ({}),
      },
      $transaction: async (callback) => callback(repairDb),
    };

    const first = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, repairDb);    expect(first.appliedCount).toBe(1);
    expect(exactArticleUpdate).toEqual(expect.objectContaining({
      isPaywall: false,
      enrichmentOutcome: expect.objectContaining({
        access: expect.objectContaining({ classification: "ACCESSIBLE" }),
      }),
    }));
    expect(exactArticleUpdate).not.toHaveProperty("publicationStatus");
    expect(exactArticleUpdate).not.toHaveProperty("bodyText");
    expect(durableArticle.isPaywall).toBe(false);
    expect((durableArticle.enrichmentOutcome as Record<string, any>).access.classification).toBe("ACCESSIBLE");
    expect(durableRepairArtifacts).toHaveLength(1);

    const feedDb = {
      user: {
        findUnique: async () => ({ sourceSubscriptions: [{ sourceId: durableArticle.sourceId }], categorySubscriptions: [] }),
      },
      article: {
        findMany: async () => [durableArticle],
      },
    };
    const feed = await loadUserFeed(feedDb, "user-1");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      id: durableArticle.id,
      isPaywall: false,
      accessClassification: "ACCESSIBLE",
    });
    expect(JSON.stringify(feed[0])).not.toContain("evidenceCodes");
    expect(JSON.stringify(feed[0])).not.toContain("paywallRepair");
    expect(isConfirmedBlockingPaywall(feed[0])).toBe(false);

    const second = await runPaywallRepair({
      apply: true,
      confirmation: PAYWALL_REPAIR_CONFIRMATION,
      environment: LOCAL_TEST_ENV,
    }, repairDb);
    expect(second.inspectedCount).toBe(0);
    expect(second.appliedCount).toBe(0);
    expect(durableRepairArtifacts).toHaveLength(1);
  });

  it("sanitizes URL/query secrets and bounds evidence", async () => {
    const sensitive = article({
      canonicalUrl: "https://example.com/story?token=secret&authorization=Bearer-secret",
      enrichmentOutcome: { kind: "SUCCESS", access: access({ evidenceCodes: ["cookie=secret", "<html>raw</html>", ...Array.from({ length: 30 }, (_, i) => `evidence-${i}`)] }) },
    });
    configureDb([sensitive]);
    const report = await runPaywallRepair({}, db());
    const output = formatPaywallRepairReport(report);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("<html>");
    expect(report.assessments[0]!.evidenceCodes.length).toBeLessThanOrEqual(12);
    expect(report.samples[0]!.newIsPaywall).toBe(false);
  });

  it("enforces deterministic source/id ordering and a bounded limit", async () => {
    const rows = [article({ id: 9, sourceId: "z-source", canonicalUrl: "https://z.example.com/story", sourceUrl: "https://z.example.com/story" }), article({ id: 2, sourceId: "a-source", canonicalUrl: "https://a.example.com/story", sourceUrl: "https://a.example.com/story" })];
    configureDb(rows);
    const report = await runPaywallRepair({ limit: 9999 }, db());
    expect(prismaMock.articleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: MAX_PAYWALL_REPAIR_LIMIT,
      orderBy: [{ sourceId: "asc" }, { id: "asc" }],
    }));
    expect(report.assessments.map((entry) => entry.article.id)).toEqual([9, 2]);
  });

  it("proposes a generic Bytepoint-style accessible false positive without publisher-specific logic", () => {
    const bytepoint = article({
      title: "Bytepoint analysis of subscription economics",
      bodyText: `${fullBody}\nThis article discusses a paywall used by another publication.`,
      enrichmentOutcome: { kind: "SUCCESS", access: access({ evidenceCodes: ["usable_full_body_extracted", "topic_signals"] }) },
    });
    const assessment = assessPaywallRepair(bytepoint, { artifacts: [], truncated: false, queryFailed: false });
    expect(assessment.repairEligible).toBe(true);
    expect(assessment.proposedClassification).toBe("ACCESSIBLE");
    expect(assessment.proposedIsPaywall).toBe(false);
  });
});
