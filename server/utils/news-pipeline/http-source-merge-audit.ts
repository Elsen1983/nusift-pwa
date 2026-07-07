import fs from "fs";
import path from "path";
import { prisma } from "../prisma";
import { readHttpSourceNormalizationReport } from "./http-source-normalization";

type SourceUsageSummary = {
  userSourceSubscriptions: number;
  categories: number;
  userCategorySubscriptionsViaCategories: number;
  articlesDirect: number;
  articlesViaCategories: number;
  agentLogsDirect: number;
};

export type HttpSourceMergeAuditItem = {
  httpSourceId: string;
  httpFrontPageUrl: string;
  httpsSourceId: string;
  httpsFrontPageUrl: string;
  httpUsage: SourceUsageSummary;
  httpsUsage: SourceUsageSummary;
  recommendedAction:
    | "safe_delete_http_source"
    | "needs_merge_before_delete"
    | "manual_review";
};

export type HttpSourceMergeAuditReport = {
  generatedAt: string;
  summary: {
    totalConflictPairs: number;
    safeDeleteHttpSource: number;
    needsMergeBeforeDelete: number;
    manualReview: number;
  };
  items: HttpSourceMergeAuditItem[];
};

export function getHttpSourceMergeAuditReportPath() {
  return path.join(process.cwd(), "data", "http-source-merge-audit-report.json");
}

const getSourceUsageSummary = async (sourceId: string): Promise<SourceUsageSummary> => {
  const [
    userSourceSubscriptions,
    categories,
    articlesDirect,
    agentLogsDirect,
    categoryRows,
  ] = await Promise.all([
    prisma.userSourceSubscription.count({ where: { sourceId } }),
    prisma.sourceCategory.count({ where: { newsSourceId: sourceId } }),
    prisma.article.count({ where: { sourceId } }),
    prisma.agentScanLog.count({ where: { sourceId } }),
    prisma.sourceCategory.findMany({
      where: { newsSourceId: sourceId },
      select: { id: true },
    }),
  ]);

  const categoryIds = categoryRows.map((row) => row.id);

  const [userCategorySubscriptionsViaCategories, articlesViaCategories] = categoryIds.length
    ? await Promise.all([
        prisma.userCategorySubscription.count({
          where: { categoryId: { in: categoryIds } },
        }),
        prisma.article.count({
          where: { categoryId: { in: categoryIds } },
        }),
      ])
    : [0, 0];

  return {
    userSourceSubscriptions,
    categories,
    userCategorySubscriptionsViaCategories,
    articlesDirect,
    articlesViaCategories,
    agentLogsDirect,
  };
};

const hasHttpDataToMerge = (usage: SourceUsageSummary) =>
  usage.userSourceSubscriptions > 0 ||
  usage.categories > 0 ||
  usage.userCategorySubscriptionsViaCategories > 0 ||
  usage.articlesDirect > 0 ||
  usage.articlesViaCategories > 0 ||
  usage.agentLogsDirect > 0;

export async function buildHttpSourceMergeAuditReport() {
  const normalizationReport = readHttpSourceNormalizationReport();
  const conflictItems = normalizationReport.items.filter(
    (item) =>
      item.action === "conflict_existing_https" &&
      item.conflictingSourceId &&
      item.conflictingFrontPageUrl,
  );

  const items: HttpSourceMergeAuditItem[] = [];

  for (const item of conflictItems) {
    const httpUsage = await getSourceUsageSummary(item.sourceId);
    const httpsUsage = await getSourceUsageSummary(item.conflictingSourceId!);

    const recommendedAction = hasHttpDataToMerge(httpUsage)
      ? "needs_merge_before_delete"
      : "safe_delete_http_source";

    items.push({
      httpSourceId: item.sourceId,
      httpFrontPageUrl: item.currentFrontPageUrl,
      httpsSourceId: item.conflictingSourceId!,
      httpsFrontPageUrl: item.conflictingFrontPageUrl!,
      httpUsage,
      httpsUsage,
      recommendedAction,
    });
  }

  const report: HttpSourceMergeAuditReport = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalConflictPairs: items.length,
      safeDeleteHttpSource: items.filter(
        (item) => item.recommendedAction === "safe_delete_http_source",
      ).length,
      needsMergeBeforeDelete: items.filter(
        (item) => item.recommendedAction === "needs_merge_before_delete",
      ).length,
      manualReview: items.filter((item) => item.recommendedAction === "manual_review").length,
    },
    items,
  };

  fs.writeFileSync(getHttpSourceMergeAuditReportPath(), JSON.stringify(report, null, 2), "utf-8");
  return report;
}
