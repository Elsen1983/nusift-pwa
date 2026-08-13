/**
 * Shared bounded structured-data mechanism for reading JSON-LD and Next.js
 * `__NEXT_DATA__` blocks out of HTML the pipeline has already fetched. This
 * module never issues network requests and never executes script text — it
 * only parses and traverses already-received bytes.
 *
 * Policy-agnostic: callers supply their own type allow-lists. Agent 2 (link
 * discovery) and Agent 3 (body trust) intentionally differ on which JSON-LD
 * types they accept.
 */

export const STRUCTURED_DATA_MAX_SCRIPT_CHARS = 1_000_000;
export const STRUCTURED_DATA_MAX_SCRIPTS_PER_PAGE = 20;
export const STRUCTURED_DATA_MAX_TRAVERSAL_DEPTH = 12;
export const STRUCTURED_DATA_MAX_OBJECTS_VISITED = 2_000;
export const STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED = 200;
export const STRUCTURED_DATA_MAX_CANDIDATES = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** All declared JSON-LD `@type` values, namespace-prefix stripped (e.g. "schema:NewsArticle" -> "NewsArticle"). */
export function getJsonLdTypes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/^[^:]*:/, ""));
}

/** The first declared `@type`, namespace-prefix stripped. Preserves today's single-type exposure. */
export function normalizeJsonLdType(raw: unknown): string {
  return getJsonLdTypes(raw)[0] ?? "";
}

/**
 * Extract `<script type="application/ld+json">` blocks (and optionally the
 * single `<script id="__NEXT_DATA__">` block) from already-fetched HTML.
 * Bounded by script count and per-block character length. Never executes
 * script text.
 */
export function extractStructuredScriptBlocks(
  html: string,
  options: { includeNextData?: boolean } = {},
): Array<{ text: string; kind: "ld+json" | "next-data" }> {
  const blocks: Array<{ text: string; kind: "ld+json" | "next-data" }> = [];
  const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    if (blocks.length >= STRUCTURED_DATA_MAX_SCRIPTS_PER_PAGE) break;
    const text = match[1]?.trim();
    if (!text) continue;
    blocks.push({ text: text.slice(0, STRUCTURED_DATA_MAX_SCRIPT_CHARS), kind: "ld+json" });
  }
  if (options.includeNextData) {
    const nextDataRegex = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
    const nextMatch = nextDataRegex.exec(html);
    const text = nextMatch?.[1]?.trim();
    if (text) blocks.push({ text: text.slice(0, STRUCTURED_DATA_MAX_SCRIPT_CHARS), kind: "next-data" });
  }
  return blocks;
}

/** Size-guarded `JSON.parse`. Returns null for oversized or malformed input. */
export function parseBoundedJson(text: string): unknown {
  if (!text || text.length > STRUCTURED_DATA_MAX_SCRIPT_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type StructuredTraversalBounds = {
  maxDepth?: number;
  maxObjects?: number;
  maxArrayLength?: number;
};

/**
 * Bounded recursive collection of plain objects (including `@graph` arrays
 * and nested arrays) satisfying `predicate`. Depth, total-objects-visited,
 * and per-array-length are all capped so a malformed, oversized, deeply
 * nested, or hand-built-cyclic structure stops boundedly instead of hanging
 * or overflowing the call stack. Real `JSON.parse` output cannot itself be
 * cyclic, but the visited-guard is defense in depth for any caller-built
 * object graph.
 */
export function collectMatchingObjects(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
  bounds: StructuredTraversalBounds = {},
): Array<Record<string, unknown>> {
  const maxDepth = bounds.maxDepth ?? STRUCTURED_DATA_MAX_TRAVERSAL_DEPTH;
  const maxObjects = bounds.maxObjects ?? STRUCTURED_DATA_MAX_OBJECTS_VISITED;
  const maxArrayLength = bounds.maxArrayLength ?? STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED;
  const out: Array<Record<string, unknown>> = [];
  const visited = new WeakSet<object>();
  let visitedCount = 0;

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || visitedCount >= maxObjects) return;
    if (Array.isArray(node)) {
      const bound = Math.min(node.length, maxArrayLength);
      for (let i = 0; i < bound; i += 1) {
        if (visitedCount >= maxObjects) return;
        walk(node[i], depth + 1);
      }
      return;
    }
    if (!isRecord(node)) return;
    if (visited.has(node)) return;
    visited.add(node);
    visitedCount += 1;
    if (predicate(node)) out.push(node);
    for (const nested of Object.values(node)) {
      if (visitedCount >= maxObjects) return;
      walk(nested, depth + 1);
    }
  };

  walk(value, 0);
  return out;
}

export type StructuredItemListEntry = {
  url: string;
  name?: string;
  itemType?: string;
};

/** Nested `item["@type"]` values that mean "not an article" — breadcrumb/product/navigation listings. */
const ITEMLIST_REJECTED_ITEM_TYPES = new Set([
  "Product",
  "Person",
  "Organization",
  "Place",
  "Event",
  "Recipe",
  "BreadcrumbList",
]);

/**
 * Extract `itemListElement` entries from JSON-LD `ItemList` objects found
 * anywhere in `root`. Rejects `BreadcrumbList`-typed lists outright (checked
 * against every declared `@type`, not just the first, so a multi-typed
 * `@type` array cannot slip past it), and rejects any entry whose nested
 * `item` declares a known non-article type. This is the extraction-layer
 * defense against breadcrumb/navigation/product listings; the existing
 * downstream URL/scope/scoring pipeline is a second line of defense.
 */
export function extractItemListEntries(root: unknown): StructuredItemListEntry[] {
  const lists = collectMatchingObjects(root, (record) => {
    const types = getJsonLdTypes(record["@type"]);
    return types.includes("ItemList") && !types.includes("BreadcrumbList");
  });

  const out: StructuredItemListEntry[] = [];
  for (const list of lists) {
    const elements = Array.isArray(list.itemListElement) ? list.itemListElement : [];
    const bound = Math.min(elements.length, STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED);
    for (let i = 0; i < bound; i += 1) {
      const entry = elements[i];
      if (!isRecord(entry)) continue;
      const item = isRecord(entry.item) ? entry.item : null;
      const itemType = item ? normalizeJsonLdType(item["@type"]) : "";
      if (itemType && ITEMLIST_REJECTED_ITEM_TYPES.has(itemType)) continue;

      const rawUrl =
        (typeof item?.url === "string" && item.url) ||
        (typeof item?.["@id"] === "string" && (item["@id"] as string)) ||
        (typeof entry.url === "string" && entry.url) ||
        "";
      if (!rawUrl) continue;

      const name =
        (typeof item?.name === "string" && item.name) ||
        (typeof item?.headline === "string" && item.headline) ||
        (typeof entry.name === "string" && entry.name) ||
        undefined;

      out.push({ url: rawUrl, name: name || undefined, itemType: itemType || undefined });
      if (out.length >= STRUCTURED_DATA_MAX_CANDIDATES) return out;
    }
  }
  return out;
}

export type StructuredNextDataCandidate = {
  url: string;
  title?: string;
  date?: string;
};

const NEXT_DATA_URL_FIELDS = ["url", "slug", "href", "link"];
const NEXT_DATA_TITLE_FIELDS = ["title", "headline", "name"];
const NEXT_DATA_DATE_FIELDS = ["publishedAt", "date", "datePublished", "createdAt"];

const readStringField = (record: Record<string, unknown>, names: string[]): string | undefined => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

/**
 * Bounded, generic scan of a `__NEXT_DATA__` script's `props.pageProps` for
 * arrays of objects that look article-like: a URL-like field resolvable to
 * an absolute URL, plus a title-like or date-like field. No knowledge of any
 * specific site's `pageProps` schema is assumed — this is deliberately
 * conservative ("sufficient evidence"), not an exhaustive site-shape parser.
 */
export function extractNextDataCandidates(scriptText: string, pageUrl: string): StructuredNextDataCandidate[] {
  const parsed = parseBoundedJson(scriptText);
  if (!isRecord(parsed)) return [];
  const props = isRecord(parsed.props) ? parsed.props.pageProps : null;
  if (!isRecord(props)) return [];

  const out: StructuredNextDataCandidate[] = [];
  const seenUrls = new Set<string>();
  const visited = new WeakSet<object>();
  let visitedCount = 0;

  const collectFromArray = (arr: unknown[]): void => {
    const bound = Math.min(arr.length, STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED);
    for (let i = 0; i < bound; i += 1) {
      if (out.length >= STRUCTURED_DATA_MAX_CANDIDATES) return;
      const item = arr[i];
      if (!isRecord(item)) continue;
      const rawUrl = readStringField(item, NEXT_DATA_URL_FIELDS);
      if (!rawUrl) continue;
      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(rawUrl, pageUrl).toString();
      } catch {
        continue;
      }
      const title = readStringField(item, NEXT_DATA_TITLE_FIELDS);
      const date = readStringField(item, NEXT_DATA_DATE_FIELDS);
      if (!title && !date) continue;
      if (seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);
      out.push({ url: resolvedUrl, title, date });
    }
  };

  const walk = (node: unknown, depth: number): void => {
    if (out.length >= STRUCTURED_DATA_MAX_CANDIDATES) return;
    if (depth > STRUCTURED_DATA_MAX_TRAVERSAL_DEPTH || visitedCount >= STRUCTURED_DATA_MAX_OBJECTS_VISITED) return;
    if (Array.isArray(node)) {
      collectFromArray(node);
      return;
    }
    if (!isRecord(node)) return;
    if (visited.has(node)) return;
    visited.add(node);
    visitedCount += 1;
    for (const value of Object.values(node)) {
      if (out.length >= STRUCTURED_DATA_MAX_CANDIDATES) return;
      walk(value, depth + 1);
    }
  };

  walk(props, 0);
  return out;
}
