export type DashboardSourceFilterOption = {
  id: string;
  type: "ROOT" | "CATEGORY";
  url: string;
};

export type DashboardSourceFilterArticle = {
  sourceUrl?: string | null;
  sourceTargetUrl?: string | null;
  categoryPathUrl?: string | null;
};

const normalizeFilterUrl = (value?: string | null) =>
  (value || "").replace(/\/+$/, "").toLowerCase();

export const matchesDashboardSourceFilter = (
  article: DashboardSourceFilterArticle,
  selectedSource: DashboardSourceFilterOption,
) => {
  const selectedUrl = normalizeFilterUrl(selectedSource.url);
  const articleSourceUrl = normalizeFilterUrl(article.sourceUrl);

  if (selectedSource.type === "ROOT") {
    // A root subscription owns articles from all of its category targets too.
    return articleSourceUrl === selectedUrl;
  }

  const articleSourceTargetUrl = normalizeFilterUrl(article.sourceTargetUrl);
  const articleCategoryPathUrl = normalizeFilterUrl(article.categoryPathUrl);
  return articleCategoryPathUrl === selectedUrl || articleSourceTargetUrl === selectedUrl;
};
