export type SubscriptionScope = {
  sourceIds: readonly string[];
  categoryIds: readonly string[];
  categoryPathUrls: readonly (string | null | undefined)[];
};

type SourceSubscription = { sourceId: string };
type CategorySubscription = {
  categoryId: string;
  category?: { pathUrl: string | null } | null;
};

export function getSubscriptionScope(
  sourceSubscriptions: readonly SourceSubscription[],
  categorySubscriptions: readonly CategorySubscription[],
): SubscriptionScope {
  return {
    sourceIds: sourceSubscriptions.map((subscription) => subscription.sourceId),
    categoryIds: categorySubscriptions.map((subscription) => subscription.categoryId),
    categoryPathUrls: categorySubscriptions.map((subscription) => subscription.category?.pathUrl),
  };
}

/**
 * Builds the article predicates for the effective active-subscription scope.
 * Category path matching intentionally complements categoryId matching so
 * legacy category-id drift does not hide articles from either consumer.
 */
export function buildSubscriptionArticleScope(scope: SubscriptionScope) {
  const categoryPathUrls = scope.categoryPathUrls.filter(
    (pathUrl): pathUrl is string => Boolean(pathUrl),
  );
  const predicates = [
    ...(scope.sourceIds.length > 0 ? [{ sourceId: { in: [...scope.sourceIds] } }] : []),
    ...(scope.categoryIds.length > 0 ? [{ categoryId: { in: [...scope.categoryIds] } }] : []),
    ...(categoryPathUrls.length > 0
      ? [{ category: { pathUrl: { in: categoryPathUrls } } }]
      : []),
  ];

  return predicates;
}

export function hasSubscriptionScope(scope: SubscriptionScope): boolean {
  return buildSubscriptionArticleScope(scope).length > 0;
}
