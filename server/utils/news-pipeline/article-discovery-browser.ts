/**
 * Agent 2 browser-based article link resolver.
 *
 * Renders target pages with Playwright and extracts article-like links from
 * the rendered DOM. Used as a fallback when static (fetch-based) discovery
 * is insufficient for JS-heavy or dynamically rendered targets.
 *
 * ## Safety
 * - Only activated when NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true
 * - Each page load is bounded by a short timeout (max 15 seconds)
 * - Only the rendered target page is inspected (no deep crawling)
 * - Same-domain filtering and utility path exclusion apply
 * - Links are scored and validated before being returned
 * - Max 25 links per target
 *
 * ## Lazy import pattern
 * Browser dependencies are imported lazily, but production serverless
 * dependencies use explicit dynamic imports so Nitro/Vercel can include them
 * in the function bundle. If the import or launch fails, the resolver returns
 * `ok: false, reason: "browser_runtime_unavailable"`.
 */

import {
  scoreCandidateUrl,
  isBlockedDiscoveryPath,
  evaluateArticleLinkCandidateFromExtractedMetadata,
  parseBoundedStaticRetryAfter,
  readStaticResponseHeader,
} from "./article-discovery-helpers";
import type {
  EvaluateArticleLinkResult,
  ArticleDiscoveryCandidateOutcome,
  PublishedAtSource,
} from "./article-discovery-helpers";
import { normalizeUrl } from "./text";
import { buildVerifiedHostScope, extendVerifiedHostScope, serializeHostScope, isHostVerified, type VerifiedHostScope } from "./canonical-host-scope";
import {
  isAgent2BrowserFallbackEnabledFlag,
  launchHeadlessBrowser,
  setBrowserLauncherForTest,
  setServerlessChromiumImporterForTest,
  type BrowserLaunchResult,
  type BrowserRuntimeSelection,
  type ExecutableResolutionResult,
} from "./browser-runtime";

// ─── Constants ──────────────────────────────────────────────────────────────

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BROWSER_SHORTLISTED_LINKS = 25;
const MAX_BROWSER_TOP_REJECTED_LINKS = 20;
const MAX_BROWSER_RAW_LINKS = 700;

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowserArticleLink = {
  url: string;
  text: string | null;
  sourcePageUrl: string;
  sourceKind: "browser";
  rawSignals: Record<string, unknown>;
};

/**
 * Compact audit entry for a raw browser link that was evaluated by
 * scoreAndFilterBrowserLinks. Explains why a link was rejected or accepted
 * for detail evaluation.
 */
export type BrowserLinkAuditEntry = {
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

export type BrowserArticleLinkResult = {
  ok: boolean;
  reason?: string;
  renderedUrl?: string;
  links: BrowserArticleLink[];
  rawLinkCount: number;
  shortlistedLinkCount: number;
  topRejectedLinks: BrowserLinkAuditEntry[];
  shortlistedLinkSamples: BrowserLinkAuditEntry[];
  topRejectionReasons: Array<{ reason: string; count: number }>;
  diagnostics: {
    pageTitle: string | null;
    linkCount: number;
    articleLikeLinkCount: number;
    rawExtractionFallbackUsed?: boolean;
    rawExtractionError?: string;
    blockedReason?: string;
    browserRuntimeAvailable: boolean;
    elapsedMs: number;
  };
  /**
   * Bounded evidence of verified host transitions (redirect / final URL /
   * document canonical) accepted for this rendered target. Query values are
   * redacted. Present when the browser ran successfully.
   */
  canonicalHostEvidence?: Array<{
    host: string;
    establishedBy: "configured_target" | "redirect" | "final_url" | "document_canonical";
    via: string;
    trusted: boolean;
  }>;
  /** Internal authoritative scope reused by browser detail evaluation. */
  verifiedHostScope?: VerifiedHostScope | null;
};

// ─── Feature Gate ───────────────────────────────────────────────────────────

/**
 * Check if the Agent 2 browser fallback is enabled via environment flag.
 */
export function isBrowserFallbackEnabled(): boolean {
  return isAgent2BrowserFallbackEnabledFlag();
}

// ─── Link Extraction from Rendered DOM ──────────────────────────────────────

/**
 * Raw link data extracted from the browser DOM via page.evaluate().
 * These are the same-domain, deduplicated anchor URLs and their text.
 * Scoring and filtering happen in Node.js after extraction.
 */
type RawBrowserLink = {
  url: string;
  text: string | null;
  dateText: string | null;
};

/**
 * Extract raw anchor URLs from the rendered DOM inside the browser context.
 * Runs via page.evaluate() so it has access to the live DOM.
 * Returns deduplicated, resolved anchor URLs. Only obviously non-link hrefs
 * (hash-only, javascript:, mailto:, tel:) are skipped. Domain, category,
 * and URL quality validation happen Node-side in scoreAndFilterBrowserLinks
 * so the full bounded raw sample can be audited.
 */
async function extractRawLinksFromBrowser(
  page: any,
  pageUrl: string,
): Promise<RawBrowserLink[]> {
  return page.evaluate(`(() => {
    const pageUrl = ${JSON.stringify(pageUrl)};
    const maxLinks = ${MAX_BROWSER_RAW_LINKS};
    const results = [];
    const seen = new Set();

    const addContainer = (containers, candidate) => {
      if (candidate && !containers.includes(candidate)) containers.push(candidate);
    };

    const closestClassMatch = (anchor, terms) => {
      let current = anchor;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const className = typeof current.className === "string" ? current.className.toLowerCase() : "";
        if (terms.some((term) => className.includes(term))) return current;
        current = current.parentElement;
      }
      return null;
    };

    const extractNearbyDateText = (anchor) => {
      const containers = [];
      try { addContainer(containers, anchor.closest("article")); } catch {}
      try { addContainer(containers, anchor.closest("li")); } catch {}
      addContainer(containers, closestClassMatch(anchor, ["story", "article", "news"]));
      addContainer(containers, anchor.parentElement);
      addContainer(containers, anchor.parentElement && anchor.parentElement.parentElement);

      const patterns = [
        new RegExp("\\\\b\\\\d{1,2}\\\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\\\s+\\\\d{4}\\\\b", "i"),
        new RegExp("\\\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\\\s+\\\\d{1,2},?\\\\s+\\\\d{4}\\\\b", "i"),
        new RegExp("\\\\b\\\\d{4}[/-]\\\\d{1,2}[/-]\\\\d{1,2}\\\\b"),
        new RegExp("\\\\b\\\\d{1,2}[/-]\\\\d{1,2}[/-]\\\\d{4}\\\\b"),
      ];

      for (const container of containers) {
        const text = (container.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 800);
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match && match[0]) return match[0];
        }
      }

      return null;
    };

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      try {
        const href = anchor.getAttribute("href");
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        ) {
          continue;
        }

        let resolved;
        try {
          resolved = new URL(href, pageUrl).toString();
        } catch {
          continue;
        }

        const normalized = resolved.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        const text = anchor.textContent && anchor.textContent.trim()
          ? anchor.textContent.trim().slice(0, 200)
          : null;
        results.push({ url: resolved, text, dateText: extractNearbyDateText(anchor) });

        if (results.length >= maxLinks) break;
      } catch {
        continue;
      }
    }

    return results;
  })()`);

  return page.evaluate(
    (args: { pageUrl: string; maxLinks: number }) => {
      const { pageUrl, maxLinks } = args;
      const results: Array<{ url: string; text: string | null; dateText: string | null }> = [];
      const seen = new Set<string>();

      const extractNearbyDateText = (anchor: Element): string | null => {
        const containers: Element[] = [];
        const addContainer = (candidate: Element | null | undefined) => {
          if (candidate && !containers.includes(candidate)) containers.push(candidate);
        };
        const safeClosest = (selector: string) => {
          try {
            return anchor.closest(selector);
          } catch {
            return null;
          }
        };
        const closestClassMatch = (terms: string[]) => {
          let current: Element | null = anchor;
          for (let depth = 0; current && depth < 6; depth += 1) {
            const className = typeof current.className === "string" ? current.className.toLowerCase() : "";
            if (terms.some((term) => className.includes(term))) return current;
            current = current.parentElement;
          }
          return null;
        };

        addContainer(safeClosest("article"));
        addContainer(safeClosest("li"));
        addContainer(closestClassMatch(["story", "article", "news"]));
        addContainer(anchor.parentElement);
        addContainer(anchor.parentElement?.parentElement || null);

        const patterns = [
          /\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i,
          /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i,
          /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/,
          /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/,
        ];

        for (const container of containers) {
          const text = (container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 800);
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match?.[0]) return match[0];
          }
        }

        return null;
      };

      const anchors = Array.from(document.querySelectorAll("a[href]"));

      for (const anchor of anchors) {
        try {
          const href = (anchor as HTMLAnchorElement).getAttribute("href");
          // Only skip obviously non-link hrefs. Domain, category, and URL
          // validation are handled Node-side by scoreAndFilterBrowserLinks
          // so the full bounded raw sample can be audited.
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
          ) {
            continue;
          }

          let resolved: string;
          try {
            resolved = new URL(href, pageUrl).toString();
          } catch {
            continue;
          }

          const normalized = resolved.toLowerCase();
          if (seen.has(normalized)) continue;
          seen.add(normalized);

          results.push({
            url: resolved,
            text: (anchor as HTMLAnchorElement).textContent?.trim().slice(0, 200) || null,
            dateText: extractNearbyDateText(anchor),
          });

          if (results.length >= maxLinks) break;
        } catch {
          // Keep extraction page-wide resilient. A single unusual anchor or DOM
          // API quirk must not turn an entire rendered page into raw links: 0.
          continue;
        }
      }

      return results;
    },
    { pageUrl, maxLinks: MAX_BROWSER_RAW_LINKS },
  );
}

async function extractBasicRawLinksFromBrowser(
  page: any,
  pageUrl: string,
): Promise<RawBrowserLink[]> {
  return page.evaluate(
    (args: { pageUrl: string; maxLinks: number }) => {
      const { pageUrl, maxLinks } = args;
      const results: Array<{ url: string; text: string | null; dateText: null }> = [];
      const seen = new Set<string>();

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (anchor as HTMLAnchorElement).getAttribute("href");
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        ) {
          continue;
        }

        let resolved: string;
        try {
          resolved = new URL(href, pageUrl).toString();
        } catch {
          continue;
        }

        const normalized = resolved.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        results.push({
          url: resolved,
          text: (anchor as HTMLAnchorElement).textContent?.trim().slice(0, 200) || null,
          dateText: null,
        });

        if (results.length >= maxLinks) break;
      }

      return results;
    },
    { pageUrl, maxLinks: MAX_BROWSER_RAW_LINKS },
  );
}

/**
 * Score and filter raw browser links in Node.js using the same scoring
 * logic as static Agent 2. Returns fully typed BrowserArticleLink[].
 */
type ScoreAndFilterResult = {
  /** Capped to MAX_BROWSER_SHORTLISTED_LINKS */
  links: BrowserArticleLink[];
  /** Total accepted before cap (may exceed links.length) */
  totalAcceptedBeforeCap: number;
  topRejectedLinks: BrowserLinkAuditEntry[];
  shortlistedLinkSamples: BrowserLinkAuditEntry[];
  topRejectionReasons: Array<{ reason: string; count: number }>;
};

function isCategoryDirectoryPath(url: string | null): boolean {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return /^\/categor(?:y|ies)\/[^/]+$/i.test(path);
  } catch {
    return false;
  }
}

function isSameListingPath(rawUrl: string, pageUrl: string): boolean {
  try {
    const raw = new URL(rawUrl);
    const page = new URL(pageUrl);
    const rawPath = raw.pathname.replace(/\/+$/, "") || "/";
    const pagePath = page.pathname.replace(/\/+$/, "") || "/";
    return raw.hostname.replace(/^www\./, "") === page.hostname.replace(/^www\./, "") && rawPath === pagePath;
  } catch {
    return false;
  }
}

function isStrongListingContextArticle(
  raw: RawBrowserLink,
  pageUrl: string,
  categoryPathUrl: string | null,
  verifiedHostScope: VerifiedHostScope | null,
): { accepted: boolean; score: number; reasons: string[] } {
  if (!isCategoryDirectoryPath(categoryPathUrl)) {
    return { accepted: false, score: 0, reasons: [] };
  }

  try {
    const path = new URL(raw.url).pathname.replace(/\/+$/, "") || "/";
    if (isCategoryDirectoryPath(raw.url) || path === "/" || isSameListingPath(raw.url, pageUrl)) {
      return { accepted: false, score: 0, reasons: ["category_directory_or_listing_page"] };
    }
  } catch {
    return { accepted: false, score: 0, reasons: ["invalid_url"] };
  }

      const score = scoreCandidateUrl(raw.url, pageUrl, {
        title: raw.text,
        dateText: raw.dateText,          categoryPathUrl: null,
          verifiedHostScope,
        });

  const hasUsefulAnchor = Boolean(raw.text && raw.text.trim().length >= 12);
  const accepted = !score.rejected && score.score >= 50 && hasUsefulAnchor;
  return {
    accepted,
    score: score.score,
    reasons: accepted
      ? [...score.reasons, "listing_context_scope"]
      : [...score.reasons, hasUsefulAnchor ? "weak_listing_context" : "weak_anchor_text"],
  };
}

function scoreAndFilterBrowserLinks(
  rawLinks: RawBrowserLink[],
  pageUrl: string,
  categoryPathUrl: string | null,
  verifiedHostScope: VerifiedHostScope | null,
): ScoreAndFilterResult {
  // Collect ALL accepted candidates — we iterate the full raw sample so that
  // rejectedLinks and rejectionReasonCounts cover every link, not just the
  // ones seen before the shortlist cap is hit.
  const allAccepted: BrowserArticleLink[] = [];
  const allAcceptedEntries: BrowserLinkAuditEntry[] = [];
  const rejectedLinks: BrowserLinkAuditEntry[] = [];
  const rejectionReasonCounts: Record<string, number> = {};

  const pageHostname = (() => {
    try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();

  for (const raw of rawLinks) {
    let normalizedUrl: string | null = null;
    try { normalizedUrl = normalizeUrl(raw.url); } catch { normalizedUrl = null; }

    // ── Domain validation (moved from browser-context extraction) ──
    let sameDomain = false;
    try {
      sameDomain = verifiedHostScope
        ? isHostVerified(verifiedHostScope, raw.url)
        : new URL(raw.url).hostname.replace(/^www\./, "") === pageHostname;
    } catch { /* invalid URL below */ }

    // ── Invalid URL detection ──────────────────────────────────────
    if (!normalizedUrl) {
      const entry: BrowserLinkAuditEntry = {
        url: raw.url,
        normalizedUrl: null,
        anchorText: raw.text?.slice(0, 100) || null,
        score: 0,
        rejected: true,
        reason: "invalid_url",
        scoreReasons: ["invalid_url"],
        sameDomain: false,
        utilityPath: false,
        categoryScoped: null,
      };
      rejectedLinks.push(entry);
      rejectionReasonCounts["invalid_url"] = (rejectionReasonCounts["invalid_url"] || 0) + 1;
      continue;
    }

    const isUtilityPath = isBlockedDiscoveryPath(raw.url);

    // ── Category scope validation (moved from browser-context extraction) ──
    let categoryScoped: boolean | null = null;
    if (categoryPathUrl) {
      try {
        const articlePath = new URL(raw.url).pathname.replace(/\/+$/, "") || "/";
        const categoryPath = new URL(categoryPathUrl).pathname.replace(/\/+$/, "") || "/";
        categoryScoped = categoryPath === "/" || articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`);
      } catch { categoryScoped = false; }
    }

    const makeAuditEntry = (rejected: boolean, reason: string | null, scoreResult: { score: number; reasons: string[] }): BrowserLinkAuditEntry => ({
      url: raw.url,
      normalizedUrl,
      anchorText: raw.text?.slice(0, 100) || null,
      score: scoreResult.score,
      rejected,
      reason,
      scoreReasons: scoreResult.reasons,
      sameDomain,
      utilityPath: isUtilityPath,
      categoryScoped,
    });

    // Reject cross-domain links
    if (!sameDomain) {
      const entry = makeAuditEntry(true, "different_domain", { score: 0, reasons: ["different_domain"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["different_domain"] = (rejectionReasonCounts["different_domain"] || 0) + 1;
      continue;
    }

    // Reject utility path links
    if (isUtilityPath) {
      const entry = makeAuditEntry(true, "utility_path", { score: 0, reasons: ["utility_path"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["utility_path"] = (rejectionReasonCounts["utility_path"] || 0) + 1;
      continue;
    }

    // Note: URL policy check (isLikelyArticleUrl) is applied downstream in
    // evaluateArticleLinkCandidateFromExtractedMetadata, so we don't duplicate
    // it here. This preserves specific rejection reasons (listing_page,
    // out_of_category_scope) instead of collapsing them into url_policy_rejected.

    if (normalizedUrl === normalizeUrl(pageUrl) || isSameListingPath(raw.url, pageUrl)) {
      const entry = makeAuditEntry(true, "listing_page", { score: 0, reasons: ["listing_page"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["listing_page"] = (rejectionReasonCounts["listing_page"] || 0) + 1;
      continue;
    }

    // Reject out-of-category-scope links unless the target is a category
    // directory page whose article URLs intentionally live outside that
    // directory. This is common on sites such as /category/arizona-news where
    // the listing page is category-scoped but article detail URLs are global.
    if (categoryScoped === false) {
      const listingContext = isStrongListingContextArticle(raw, pageUrl, categoryPathUrl, verifiedHostScope);
      if (!listingContext.accepted) {
        const entry = makeAuditEntry(true, "out_of_category_scope", {
          score: listingContext.score,
          reasons: listingContext.reasons.length > 0 ? listingContext.reasons : ["out_of_category_scope"],
        });
        rejectedLinks.push(entry);
        rejectionReasonCounts["out_of_category_scope"] = (rejectionReasonCounts["out_of_category_scope"] || 0) + 1;
        continue;
      }

      const entry = makeAuditEntry(false, null, {
        score: listingContext.score,
        reasons: listingContext.reasons,
      });
      allAcceptedEntries.push(entry);

      allAccepted.push({
        url: raw.url,
        text: raw.text,
        sourcePageUrl: `browser:${pageUrl}`,
        sourceKind: "browser",
        rawSignals: {
          anchorText: raw.text?.slice(0, 100) || null,
          listingDateText: raw.dateText,
          score: listingContext.score,
          scoreReasons: listingContext.reasons,
        },
      });
      continue;
    }

    // Score the candidate URL
    const score = scoreCandidateUrl(raw.url, pageUrl, {
      title: raw.text,
      dateText: raw.dateText,
      categoryPathUrl,
      verifiedHostScope,
    });

    if (score.rejected) {
      const rejectionReason = score.rejectionReason || "low_score";
      const entry = makeAuditEntry(true, rejectionReason, { score: score.score, reasons: score.reasons });
      rejectedLinks.push(entry);
      rejectionReasonCounts[rejectionReason] = (rejectionReasonCounts[rejectionReason] || 0) + 1;
      continue;
    }

    // Accepted for shortlist — collect ALL accepted candidates; the links
    // array is capped later so audit covers the full raw sample.
    const entry = makeAuditEntry(false, null, { score: score.score, reasons: score.reasons });
    allAcceptedEntries.push(entry);

    allAccepted.push({
      url: raw.url,
      text: raw.text,
      sourcePageUrl: `browser:${pageUrl}`,
      sourceKind: "browser",
      rawSignals: {
        anchorText: raw.text?.slice(0, 100) || null,
        listingDateText: raw.dateText,
        score: score.score,
        scoreReasons: score.reasons,
      },
    });
  }

  // ── Cap the returned links array ────────────────────────────────
  // Sort accepted by score desc, then cap to MAX_BROWSER_SHORTLISTED_LINKS.
  allAccepted.sort((a, b) => {
    const sa = (a.rawSignals as Record<string, unknown>).score as number || 0;
    const sb = (b.rawSignals as Record<string, unknown>).score as number || 0;
    return sb - sa;
  });
  allAcceptedEntries.sort((a, b) => b.score - a.score);
  const links = allAccepted.slice(0, MAX_BROWSER_SHORTLISTED_LINKS);

  // ── Build shortlisted samples (capped at 25) ───────────────────
  const shortlistedSamples: BrowserLinkAuditEntry[] = allAcceptedEntries
    .slice(0, MAX_BROWSER_SHORTLISTED_LINKS);

  // ── Build top rejected links (capped at 20, sorted by score desc)
  rejectedLinks.sort((a, b) => b.score - a.score);
  const topRejectedLinks = rejectedLinks.slice(0, MAX_BROWSER_TOP_REJECTED_LINKS);

  // ── Build top rejection reasons (from the full audited sample) ──
  const topRejectionReasons = Object.entries(rejectionReasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    links,
    totalAcceptedBeforeCap: allAccepted.length,
    topRejectedLinks,
    shortlistedLinkSamples: shortlistedSamples,
    topRejectionReasons,
  };
}

// ─── Playwright Loader (lazy) ───────────────────────────────────────────────

/**
 * Test injection API retained for existing tests. It bridges the historical
 * specifier-keyed importer into the shared browser-runtime module's test
 * hooks, so no test relies on the removed full-`playwright` fallback.
 */
type OptionalDependencyImporter = (specifier: string) => Promise<any>;

const testImporterBridge = async (
  importer: OptionalDependencyImporter,
  specifier: string,
): Promise<any> => {
  const mod = await importer(specifier);
  return mod?.default ?? mod;
};

export function setArticleDiscoveryBrowserImporterForTest(
  importer: OptionalDependencyImporter | null,
) {
  if (!importer) {
    setServerlessChromiumImporterForTest(null);
    setBrowserLauncherForTest(null);
    return;
  }

  setServerlessChromiumImporterForTest(async () => {
    const mod = await importer("@sparticuz/chromium");
    return mod?.default ?? mod;
  });
  setBrowserLauncherForTest(
    async (
      selection: BrowserRuntimeSelection,
      executable: ExecutableResolutionResult,
    ): Promise<BrowserLaunchResult> => {
      try {
        if (executable.kind === "serverless-chromium" && executable.executablePath) {
          const playwrightCore = await testImporterBridge(importer, "playwright-core");
          const serverlessChromium = await testImporterBridge(importer, "@sparticuz/chromium");
          const browser = await playwrightCore.chromium.launch({
            args: serverlessChromium.args,
            executablePath: executable.executablePath,
            headless: serverlessChromium.headless ?? true,
          });
          return {
            browser,
            classification: "browser_runtime_available",
            kind: "serverless-chromium",
            blockedReason: null,
          };
        }
        if (executable.kind === "system-chrome" || executable.kind === "custom-executable") {
          const playwrightCore = await testImporterBridge(importer, "playwright-core");
          const browser = await playwrightCore.chromium.launch({ headless: true });
          return {
            browser,
            classification: "browser_runtime_available",
            kind: executable.kind,
            blockedReason: null,
          };
        }
        return {
          browser: null,
          classification: "browser_runtime_unavailable",
          kind: "unavailable",
          blockedReason: executable.reason ?? "no browser runtime selected",
        };
      } catch (error) {
        // A launch failure is a runtime problem, never a fake success. The
        // diagnostic keeps the historical "playwright" label for the
        // local/system-Chrome path (the launch runs through playwright-core).
        const label = executable.kind === "system-chrome" ? "playwright" : executable.kind;
        return {
          browser: null,
          classification: "browser_runtime_unavailable",
          kind: executable.kind,
          blockedReason: `${label}: ${getErrorMessage(error)}`,
        };
      }
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Launch the headless browser through the shared Vercel-compatible runtime.
 *
 * Never falls back to the full `playwright` package (it is not installed) and
 * never fabricates a successful result: a missing runtime is classified as
 * BROWSER_RUNTIME_UNAVAILABLE (a platform failure, not a publisher outcome).
 */
export async function launchBrowser(): Promise<{
  browser: any | null;
  blockedReason?: string;
  viewport?: { width: number; height: number } | null;
}> {
  const result = await launchHeadlessBrowser();
  return {
    browser: result.browser,
    blockedReason: result.blockedReason ?? undefined,
    viewport: result.viewport ?? null,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover article links from a rendered page using Playwright.
 *
 * @param input.targetUrl - The page to render
 * @param input.sourceId - Source ID for provenance
 * @param input.categoryId - Category ID (if category target)
 * @param input.targetType - "source" or "category"
 * @param input.timeoutMs - Page load timeout (default 15s, max 15s)
 * @param input.categoryPathUrl - Category path URL for scope filtering
 */
export async function discoverArticleLinksWithBrowser(input: {
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  targetType: "source" | "category";
  timeoutMs?: number;    categoryPathUrl?: string | null;
    /** Optional scope established by the caller; otherwise derived from render evidence. */
    verifiedHostScope?: VerifiedHostScope | null;
}): Promise<BrowserArticleLinkResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(input.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const categoryPathUrl = input.categoryPathUrl || null;

  // Feature gate
  if (!isBrowserFallbackEnabled()) {
    return {
      ok: false,
      reason: "browser_fallback_disabled",
      links: [],
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is not set",
        browserRuntimeAvailable: false,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  // Launch browser
  const launchResult = await launchBrowser();  const browser = launchResult.browser;

  if (!browser) {
    return {
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: launchResult.blockedReason || "Playwright is not installed or could not be launched",
        browserRuntimeAvailable: false,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      ...(launchResult.viewport ? { viewport: launchResult.viewport } : {}),
    });
    const page = await context.newPage();

    let blockedReason: string | undefined;
    let renderedUrl: string | undefined;

    // Block heavy resources to speed up rendering
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2,ttf}", (route: any) =>
      route.abort(),
    );

    const response = await page
      .goto(input.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      })
      .catch((err: any) => {
        blockedReason = `Navigation failed: ${err?.message || String(err)}`;
        return null;
    });

    if (!response) {
      await browser.close();
      return {
        ok: false,
        reason: "navigation_failed",
        links: [],
        rawLinkCount: 0,
        shortlistedLinkCount: 0,
        topRejectedLinks: [],
        shortlistedLinkSamples: [],
        topRejectionReasons: [],
        diagnostics: {
          pageTitle: null,
          linkCount: 0,
          articleLikeLinkCount: 0,
          blockedReason,
          browserRuntimeAvailable: true,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    if (!response.ok()) {
      blockedReason = `HTTP ${response.status()}`;
      await browser.close();
      return {
        ok: false,
        reason: "http_error",
        links: [],
        rawLinkCount: 0,
        shortlistedLinkCount: 0,
        topRejectedLinks: [],
        shortlistedLinkSamples: [],
        topRejectionReasons: [],
        diagnostics: {
          pageTitle: null,
          linkCount: 0,
          articleLikeLinkCount: 0,
          blockedReason,
          browserRuntimeAvailable: true,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    renderedUrl = page.url();
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(750).catch(() => {});
    }

    // Extract article links from rendered DOM via page.evaluate()
    // (runs inside the browser context where document is available)
    const pageTitle = await page.title().catch(() => null);
    const allAnchors = await page.evaluate(() => document.querySelectorAll("a[href]").length);
    let rawExtractionFallbackUsed = false;
    let rawExtractionError: string | undefined;
    let rawLinks: RawBrowserLink[] = [];

    try {
      rawLinks = await extractRawLinksFromBrowser(page, renderedUrl || input.targetUrl);
    } catch (error) {
      rawExtractionFallbackUsed = true;
      rawExtractionError = getErrorMessage(error);
    }

    if (rawLinks.length === 0 && allAnchors > 0) {
      rawExtractionFallbackUsed = true;
      try {
        rawLinks = await extractBasicRawLinksFromBrowser(page, renderedUrl || input.targetUrl);
      } catch (error) {
        const fallbackError = getErrorMessage(error);
        rawExtractionError = rawExtractionError
          ? `${rawExtractionError}; basic fallback failed: ${fallbackError}`
          : fallbackError;
      }
    }

    // Capture the rendered document's canonical URL. When the configured root
    // host renders its content under a publisher-controlled subdomain, the
    // canonical relationship plus the final rendered URL establish the
    // verified host scope for candidate link acceptance. This runs AFTER the
    // raw-link extraction so the page.evaluate() call sequence is unchanged
    // for existing callers and tests.
    let documentCanonicalHref: string | null = null;
    try {
      const rawCanonical = await page.evaluate(() => {
        const canonical = document.querySelector('link[rel="canonical"]');
        return canonical ? canonical.getAttribute("href") : null;
      });
      if (typeof rawCanonical === "string" && rawCanonical.trim()) {
        documentCanonicalHref = rawCanonical;
      }
    } catch {
      // Canonical evidence is best-effort — a failure must not fail the render.
    }

    const derivedScope = buildVerifiedHostScope({
      configuredTargetUrl: input.targetUrl,
      finalUrl: renderedUrl || input.targetUrl,
      canonicalUrl: documentCanonicalHref,
    });
    const verifiedHostScope = input.verifiedHostScope
      ? extendVerifiedHostScope(input.verifiedHostScope, {
          finalUrl: renderedUrl || input.targetUrl,
          canonicalUrl: documentCanonicalHref,
        }) ?? input.verifiedHostScope
      : derivedScope;
    const canonicalHostEvidence = serializeHostScope(verifiedHostScope);

    const filterResult = scoreAndFilterBrowserLinks(rawLinks, renderedUrl || input.targetUrl, categoryPathUrl, verifiedHostScope);

    await browser.close();

    return {
      ok: true,
      renderedUrl,
      links: filterResult.links,
      rawLinkCount: rawLinks.length,
      shortlistedLinkCount: filterResult.totalAcceptedBeforeCap,
      topRejectedLinks: filterResult.topRejectedLinks,
      shortlistedLinkSamples: filterResult.shortlistedLinkSamples,
      topRejectionReasons: filterResult.topRejectionReasons,
      canonicalHostEvidence,
      verifiedHostScope,
      diagnostics: {
        pageTitle,
        linkCount: allAnchors,
        articleLikeLinkCount: filterResult.links.length,
        rawExtractionFallbackUsed,
        rawExtractionError,
        browserRuntimeAvailable: true,
        elapsedMs: Date.now() - startedAt,
      },
    };
  } catch (error: any) {
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
    return {
      ok: false,
      reason: "browser_error",
      links: [],
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: error?.message || String(error),
        browserRuntimeAvailable: true,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

// ─── Browser-based article detail recovery ────────────────────────────────

export type BrowserArticleDetailExtraction = {
  title: string;
  description: string;
  publishedAtRaw: string | null;
  publishedAtSource: PublishedAtSource;
  keywords: string[];
  bodyFallback: string;
  canonicalUrl: string | null;
};

const DETAIL_PAGE_TIMEOUT_MS = 15_000;
const MAX_DETAIL_PAGE_TIMEOUT_MS = 15_000;
export const MAX_BROWSER_DETAIL_EVALUATIONS = 10;
export const DEFAULT_BROWSER_DETAIL_TARGET_TIME_BUDGET_MS = 60_000;

/**
 * Detail evaluations use a fresh browser context per URL inside one
 * target-scoped browser process. Context isolation prevents cookies, storage,
 * redirect state, and page mutations from leaking while avoiding repeated
 * Chromium startup for every article.
 */
export type BrowserArticleDetailRuntime = {
  browser: any;
  launchResult: {
    viewport?: { width: number; height: number } | null;
  };
  /** Target-scoped deadline shared by every detail navigation in the session. */
  deadlineAt: number;
  /** Injectable clock keeps deadline behavior deterministic in tests. */
  now: () => number;
};

/** Typed control-flow signal: the target browser budget, not the publisher, stopped evaluation. */
export class BrowserDetailTimeBudgetExceeded extends Error {
  readonly code = "BROWSER_DETAIL_TIME_BUDGET_EXHAUSTED" as const;

  constructor(message = "browser detail target time budget exhausted") {
    super(message);
    this.name = "BrowserDetailTimeBudgetExceeded";
  }
}

export type BrowserArticleDetailSession = {
  evaluate: (input: Omit<BrowserArticleDetailInput, "runtime">) => Promise<EvaluateArticleLinkResult>;
  hasTimeRemaining: () => boolean;
  getRemainingTimeMs: () => number;
  close: () => Promise<void>;
};

export function isBrowserDetailTimeBudgetExceeded(error: unknown): error is BrowserDetailTimeBudgetExceeded {
  return error instanceof BrowserDetailTimeBudgetExceeded
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "BROWSER_DETAIL_TIME_BUDGET_EXHAUSTED");
}

export type BrowserArticleDetailInput = {
  articleUrl: string;
  sourcePageUrl: string;
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  timeoutMs?: number;
  listingDateFallbackRaw?: string | null;
  verifiedHostScope?: VerifiedHostScope | null;
  runtime?: BrowserArticleDetailRuntime;
};

// ─── Raw DOM data extraction + Node-side normalization ─────────────────────

/**
 * Plain serializable data extracted from the browser DOM.
 * All fields are primitives — no DOM objects, no functions, no closures.
 * This is what page.evaluate() returns to Node.
 */
export type RawArticleDetailData = {
  pageUrl: string;
  canonicalHref: string | null;
  docTitle: string;
  h1Text: string | null;
  ogTitle: string | null;
  twitterTitle: string | null;
  metaTitle: string | null;
  ogDescription: string | null;
  metaDescription: string | null;
  twitterDescription: string | null;
  metaKeywords: string | null;
  articlePublishedTime: string | null;
  ogPublishedTime: string | null;
  pubdate: string | null;
  publishdate: string | null;
  timeDatetime: string | null;
  metaDate: string | null;
  jsonLdScripts: string[];
  bodyText: string;
};

/**
 * Node-side single source of truth: normalize raw DOM data into article
 * metadata. Handles JSON-LD parsing (including @graph and array forms),
 * title priority, date priority, keywords splitting, and body truncation.
 *
 * This function never touches the DOM — it works only with primitive values.
 */
export function normalizeArticleDetailFromRaw(
  raw: RawArticleDetailData,
): BrowserArticleDetailExtraction {
  const canonicalUrl = raw.canonicalHref || raw.pageUrl;

  // ── JSON-LD extraction (collect all objects including @graph) ────
  let jsonLdHeadline: string | null = null;
  let jsonLdName: string | null = null;
  let publishedAtRaw: string | null = null;
  let publishedAtSource: string = "unknown";

  for (const jsonText of raw.jsonLdScripts) {
    try {
      const data = JSON.parse(jsonText || "{}");
      const queue: any[] = Array.isArray(data) ? [...data] : [data];
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        // Flatten @graph arrays
        if (Array.isArray(item["@graph"])) {
          queue.push(...item["@graph"]);
          continue;
        }
        if (!publishedAtRaw && item.datePublished) {
          publishedAtRaw = String(item.datePublished);
          publishedAtSource = "datePublished";
        }
        if (!jsonLdHeadline && typeof item.headline === "string" && item.headline.trim()) {
          jsonLdHeadline = item.headline.trim();
        }
        if (!jsonLdName && typeof item.name === "string" && item.name.trim()) {
          jsonLdName = item.name.trim();
        }
      }
    } catch {
      // malformed JSON-LD — ignore
    }
  }

  // ── Title priority chain ───────────────────────────────────────
  // og:title > twitter:title > meta title > JSON-LD headline >
  // JSON-LD name > document.title > h1
  const metaTitle = raw.ogTitle || raw.twitterTitle || raw.metaTitle || null;
  const title =
    metaTitle ||
    jsonLdHeadline ||
    jsonLdName ||
    raw.docTitle ||
    raw.h1Text ||
    "";

  const description =
    raw.ogDescription || raw.metaDescription || raw.twitterDescription || "";

  // ── Date priority ──────────────────────────────────────────────
  // Each field is checked individually so publishedAtSource precisely
  // matches the selected source.
  if (!publishedAtRaw) {
    if (raw.articlePublishedTime) {
      publishedAtRaw = raw.articlePublishedTime;
      publishedAtSource = "article:published_time";
    } else if (raw.ogPublishedTime) {
      publishedAtRaw = raw.ogPublishedTime;
      publishedAtSource = "og:published_time";
    } else if (raw.pubdate) {
      publishedAtRaw = raw.pubdate;
      publishedAtSource = "article:published_time";
    } else if (raw.publishdate) {
      publishedAtRaw = raw.publishdate;
      publishedAtSource = "article:published_time";
    }
  }

  if (!publishedAtRaw && raw.timeDatetime) {
    publishedAtRaw = raw.timeDatetime;
    publishedAtSource = "time[datetime]";
  }

  if (!publishedAtRaw && raw.metaDate) {
    publishedAtRaw = raw.metaDate;
    publishedAtSource = "meta[name=date]";
  }

  const keywords = raw.metaKeywords
    ? raw.metaKeywords.split(",").map((k) => k.trim()).filter(Boolean)
    : [];

  const bodyFallback = raw.bodyText
    ? raw.bodyText.trim().replace(/\s+/g, " ").slice(0, 600)
    : "";

  return {
    canonicalUrl,
    title,
    description,
    publishedAtRaw,
    publishedAtSource: publishedAtSource as PublishedAtSource,
    keywords,
    bodyFallback,
  };
}

/**
 * Minimal document-like adapter for extracting article metadata.
 * Allows the extraction logic to be unit-tested without a real browser.
 */
export type DocumentLike = {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  title: string;
  body: ElementLike;
};

type ElementLike = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  innerText?: string;
};

/**
 * Testable mirror: extract raw data from a document-like object, then
 * delegate to normalizeArticleDetailFromRaw().
 *
 * NOTE: This function must stay in sync with the inline page.evaluate()
 * extraction in evaluateArticleLinkCandidateWithBrowser(). Both produce
 * the same RawArticleDetailData shape.
 */
export function extractArticleDetailFromDocument(
  doc: DocumentLike,
  pageUrl: string,
): BrowserArticleDetailExtraction {
  const getMetaContent = (selector: string): string | null => {
    const el = doc.querySelector(selector);
    return el?.getAttribute("content")?.trim() || null;
  };

  const canonicalLink = doc.querySelector('link[rel="canonical"]');

  const jsonLdScripts: string[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const text = scripts[i]!.textContent || "";
    if (text.trim()) jsonLdScripts.push(text);
  }

  const articleEl =
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    doc.body;

  const raw: RawArticleDetailData = {
    pageUrl,
    canonicalHref: canonicalLink?.getAttribute("href") || null,
    docTitle: doc.title || "",
    h1Text: doc.querySelector("h1")?.innerText?.trim() || null,
    ogTitle: getMetaContent('meta[property="og:title"]'),
    twitterTitle: getMetaContent('meta[name="twitter:title"]'),
    metaTitle: getMetaContent('meta[name="title"]'),
    ogDescription: getMetaContent('meta[property="og:description"]'),
    metaDescription: getMetaContent('meta[name="description"]'),
    twitterDescription: getMetaContent('meta[name="twitter:description"]'),
    metaKeywords: getMetaContent('meta[name="keywords"]'),
    articlePublishedTime:
      getMetaContent('meta[property="article:published_time"]') ||
      getMetaContent('meta[name="article:published_time"]') ||
      null,
    ogPublishedTime:
      getMetaContent('meta[property="og:published_time"]') ||
      getMetaContent('meta[name="og:published_time"]') ||
      null,
    pubdate: getMetaContent('meta[name="pubdate"]'),
    publishdate: getMetaContent('meta[name="publishdate"]'),
    timeDatetime: doc.querySelector("time[datetime]")?.getAttribute("datetime") || null,
    metaDate: getMetaContent('meta[name="date"]'),
    jsonLdScripts,
    bodyText: articleEl ? (articleEl.innerText || "") : "",
  };

  return normalizeArticleDetailFromRaw(raw);
}

/**
 * Render an article detail page in a headless browser and evaluate it using
 * the same candidate-building logic as static Agent 2.
 *
 * This is a recovery path: static `evaluateArticleLinkCandidate()` has already
 * failed (usually HTTP 403), so we render the page and extract metadata from
 * the live DOM. No raw HTML, screenshots, or DOM dumps are persisted.
 */
export async function createBrowserArticleDetailSession(input: {
  timeBudgetMs?: number;
  /** Absolute deadline supplied by the queue so listing/static work is included. */
  deadlineAt?: number;
  /** Injectable clock for deterministic budget tests. */
  now?: () => number;
} = {}): Promise<{ session: BrowserArticleDetailSession | null; blockedReason?: string; timeBudgetExhausted?: boolean }> {
  const now = input.now ?? Date.now;
  const deadlineAt = input.deadlineAt ?? (now() + Math.max(1, input.timeBudgetMs ?? DEFAULT_BROWSER_DETAIL_TARGET_TIME_BUDGET_MS));

  // Preserve the feature-gate result for standalone callers. The deadline is
  // only meaningful once browser recovery is actually enabled.
  if (!isBrowserFallbackEnabled()) {
    return { session: null, blockedReason: "browser fallback disabled" };
  }

  if (now() >= deadlineAt) {
    return {
      session: null,
      blockedReason: "browser detail target time budget exhausted",
      timeBudgetExhausted: true,
    };
  }

  const launchResult = await launchBrowser();
  if (!launchResult.browser) {
    return {
      session: null,
      blockedReason: launchResult.blockedReason || "browser runtime unavailable",
    };
  }

  const runtime: BrowserArticleDetailRuntime = {
    browser: launchResult.browser,
    launchResult: { viewport: launchResult.viewport },
    deadlineAt,
    now,
  };
  let closed = false;

  return {
    session: {
      evaluate: (detailInput) => {
        if (closed) return Promise.reject(new Error("browser detail session is closed"));
        return evaluateArticleLinkCandidateWithBrowser({ ...detailInput, runtime });
      },
      hasTimeRemaining: () => !closed && now() < deadlineAt,
      getRemainingTimeMs: () => closed ? 0 : Math.max(0, deadlineAt - now()),
      close: async () => {
        if (closed) return;
        closed = true;
        await runtime.browser.close();
      },
    },
  };
}

export async function evaluateArticleLinkCandidateWithBrowser(input: BrowserArticleDetailInput): Promise<EvaluateArticleLinkResult> {
  const startedAt = Date.now();
  const { articleUrl, sourcePageUrl, targetUrl, sourceId, categoryId } = input;
  const configuredTimeoutMs = Math.min(input.timeoutMs || DETAIL_PAGE_TIMEOUT_MS, MAX_DETAIL_PAGE_TIMEOUT_MS);
  const runtimeRemainingMs = input.runtime
    ? Math.max(0, input.runtime.deadlineAt - input.runtime.now())
    : null;
  if (runtimeRemainingMs !== null && runtimeRemainingMs <= 0) {
    throw new BrowserDetailTimeBudgetExceeded();
  }
  const timeoutMs = runtimeRemainingMs === null
    ? configuredTimeoutMs
    : Math.min(configuredTimeoutMs, runtimeRemainingMs);

  const reject = (
    status: ArticleDiscoveryCandidateOutcome["status"],
    reason: string,
    overrides: Partial<ArticleDiscoveryCandidateOutcome> = {},
  ): EvaluateArticleLinkResult => ({
    accepted: false,
    candidate: null,
    outcome: {
      url: articleUrl,
      sourceKind: "browser",
      status,
      reason,
      canonicalUrl: normalizeUrl(articleUrl),
      ...overrides,
    } as ArticleDiscoveryCandidateOutcome,
  });

  if (!isBrowserFallbackEnabled()) {
    return reject("fetch_failed", "browser fallback disabled");
  }

  const ownsBrowser = !input.runtime;
  const launchResult = input.runtime
    ? { browser: input.runtime.browser, viewport: input.runtime.launchResult.viewport, blockedReason: undefined }
    : await launchBrowser();
  const browser = launchResult.browser;

  if (!browser) {
    return reject("detail_validation_failed", launchResult.blockedReason || "browser runtime unavailable");
  }

  let context: any = null;
  let page: any = null;
  try {
    context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      ...(launchResult.viewport ? { viewport: launchResult.viewport } : {}),
    });
    page = await context.newPage();

    // Block heavy resources just like the listing browser path.
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2,ttf}", (route: any) =>
      route.abort(),
    );

    // Context/page setup and route registration also consume the target budget.
    // Recalculate immediately before navigation so the page timeout cannot be
    // stale or larger than the remaining target wall-clock budget.
    const navigationRemainingMs = input.runtime
      ? Math.max(0, input.runtime.deadlineAt - input.runtime.now())
      : null;
    if (navigationRemainingMs !== null && navigationRemainingMs <= 0) {
      throw new BrowserDetailTimeBudgetExceeded();
    }
    const navigationTimeoutMs = navigationRemainingMs === null
      ? configuredTimeoutMs
      : Math.min(configuredTimeoutMs, navigationRemainingMs);

    let response: any = null;
    try {
      response = await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    } catch (error) {
      // A navigation timeout at the target deadline is control flow, not a
      // publisher/article failure. Preserve other navigation failures as-is.
      if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
        throw new BrowserDetailTimeBudgetExceeded();
      }
      return reject("fetch_failed", "navigation failed");
    }

    if (!response) {
      if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
        throw new BrowserDetailTimeBudgetExceeded();
      }
      return reject("fetch_failed", "navigation failed");
    }

    // Check HTTP status before the deadline so a confirmed 429 retains its
    // precedence over generic time-budget handling.
    if (!response.ok()) {
      const status = response.status();
      if (status === 429) {
        const headers = typeof response.headers === "function"
          ? await Promise.resolve().then(() => response.headers()).catch(() => null)
          : response.headers ?? null;
        const parsed = parseBoundedStaticRetryAfter(
          readStaticResponseHeader(headers ? { headers } : null, "retry-after"),
        );
        return reject("fetch_failed", "HTTP 429", {
          httpStatus: 429,
          rateLimited: true,
          retryAfterAt: parsed.retryAfterAt,
          retryAfterSource: parsed.source,
        });
      }
      return reject("fetch_failed", `HTTP ${status}`, { httpStatus: status });
    }

    if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
      throw new BrowserDetailTimeBudgetExceeded();
    }

    const renderedUrl = page.url();
    if (typeof page.waitForTimeout === "function") {
      const remaining = input.runtime
        ? Math.max(0, input.runtime.deadlineAt - input.runtime.now())
        : 500;
      if (remaining <= 0) throw new BrowserDetailTimeBudgetExceeded();
      await page.waitForTimeout(Math.min(500, remaining)).catch(() => {});
      if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
        throw new BrowserDetailTimeBudgetExceeded();
      }
    }

    // Extract raw primitive data from the live DOM. The page.evaluate()
    // callback uses only document and args — no module-scope closures.
    // The raw data is then normalized on the Node side by
    // normalizeArticleDetailFromRaw(), which is the single source of truth
    // for JSON-LD parsing, title priority, and date priority.
    //
    // NOTE: Keep this extraction in sync with extractArticleDetailFromDocument()
    // below — both must produce the same RawArticleDetailData shape.
    const raw = (await page.evaluate(`(() => {
      const pageUrl = ${JSON.stringify(renderedUrl || articleUrl)};

      const getMetaContent = (selector) => {
        const el = document.querySelector(selector);
        const content = el && el.getAttribute("content");
        return content && content.trim() ? content.trim() : null;
      };

      const canonicalLink = document.querySelector('link[rel="canonical"]');

      const jsonLdScripts = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length; i += 1) {
        const text = scripts[i] && scripts[i].textContent ? scripts[i].textContent : "";
        if (text.trim()) jsonLdScripts.push(text);
      }

      const articleEl =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.body;

      const h1 = document.querySelector("h1");
      const time = document.querySelector("time[datetime]");

      return {
        pageUrl,
        canonicalHref: canonicalLink ? canonicalLink.getAttribute("href") : null,
        docTitle: document.title || "",
        h1Text: h1 && h1.innerText ? h1.innerText.trim() : null,
        ogTitle: getMetaContent('meta[property="og:title"]'),
        twitterTitle: getMetaContent('meta[name="twitter:title"]'),
        metaTitle: getMetaContent('meta[name="title"]'),
        ogDescription: getMetaContent('meta[property="og:description"]'),
        metaDescription: getMetaContent('meta[name="description"]'),
        twitterDescription: getMetaContent('meta[name="twitter:description"]'),
        metaKeywords: getMetaContent('meta[name="keywords"]'),
        articlePublishedTime:
          getMetaContent('meta[property="article:published_time"]') ||
          getMetaContent('meta[name="article:published_time"]') ||
          null,
        ogPublishedTime:
          getMetaContent('meta[property="og:published_time"]') ||
          getMetaContent('meta[name="og:published_time"]') ||
          null,
        pubdate: getMetaContent('meta[name="pubdate"]'),
        publishdate: getMetaContent('meta[name="publishdate"]'),
        timeDatetime: time ? time.getAttribute("datetime") : null,
        metaDate: getMetaContent('meta[name="date"]'),
        jsonLdScripts,
        bodyText: articleEl && articleEl.innerText ? articleEl.innerText : "",
      };
    })()`)) as RawArticleDetailData;

    if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
      throw new BrowserDetailTimeBudgetExceeded();
    }

    const extracted = normalizeArticleDetailFromRaw(raw);
    const publishedAtRaw = extracted.publishedAtRaw || input.listingDateFallbackRaw || null;
    const publishedAtSource = extracted.publishedAtRaw
      ? extracted.publishedAtSource
      : input.listingDateFallbackRaw
        ? "listing_context"
        : extracted.publishedAtSource;

    const evaluation = await evaluateArticleLinkCandidateFromExtractedMetadata({
      articleUrl,
      sourcePageUrl,
      targetUrl,
      sourceId,
      categoryId,
      title: extracted.title,
      description: extracted.description,
      keywords: extracted.keywords,
      publishedAtRaw,
      publishedAtSource: (publishedAtSource as PublishedAtSource) || "unknown",
      bodyFallback: extracted.bodyFallback,
      extraRawSignals: ["agent2-browser-detail-recovery"],
      canonicalUrlOverride: extracted.canonicalUrl,
      allowWeakPublishedAt: true,
      verifiedHostScope: input.verifiedHostScope,
      effectiveTargetUrl: renderedUrl || null,
    });

    if (input.runtime && input.runtime.now() >= input.runtime.deadlineAt) {
      throw new BrowserDetailTimeBudgetExceeded();
    }

    return evaluation;
  } catch (error: any) {
    if (isBrowserDetailTimeBudgetExceeded(error)) throw error;
    return reject("detail_validation_failed", error?.message || String(error));
  } finally {
    try {
      await page?.close?.();
    } catch {
      // Ignore per-article page close errors.
    }
    try {
      await context?.close?.();
    } catch {
      // Ignore per-article context close errors.
    }
    if (ownsBrowser) {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
