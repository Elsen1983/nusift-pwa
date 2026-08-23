import { getDomain } from "tldts";
import { getPublisherDomainGroupId } from "./publisher-domain-groups";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function getPublisherDomain(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!HTTP_PROTOCOLS.has(parsed.protocol)) return null;

    return getDomain(parsed.hostname, { allowPrivateDomains: true })?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function isSamePublisherDomain(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;

  const leftDomain = getPublisherDomain(left);
  const rightDomain = getPublisherDomain(right);
  return leftDomain !== null && rightDomain !== null && leftDomain === rightDomain;
}

export type FeedPublisherCompatibility = {
  allowed: boolean;
  reason: "same_publisher_domain" | "invalid_domain" | "missing_entry_evidence" | "entry_domain_mismatch" | "verified_entry_domain" | "verified_domain_group";
  feedDomain: string | null;
  targetDomain: string | null;
  inspectedEntryCount: number;
  matchingEntryCount: number;
  foreignEntryCount: number;
};

export function assessFeedPublisherCompatibility(input: {
  feedUrl: string;
  targetUrl: string;
  entryUrls?: readonly string[];
}): FeedPublisherCompatibility {
  const feedDomain = getPublisherDomain(input.feedUrl);
  const targetDomain = getPublisherDomain(input.targetUrl);

  if (!feedDomain || !targetDomain) {
    return {
      allowed: false,
      reason: "invalid_domain",
      feedDomain,
      targetDomain,
      inspectedEntryCount: 0,
      matchingEntryCount: 0,
      foreignEntryCount: 0,
    };
  }

  if (feedDomain === targetDomain) {
    return {
      allowed: true,
      reason: "same_publisher_domain",
      feedDomain,
      targetDomain,
      inspectedEntryCount: 0,
      matchingEntryCount: 0,
      foreignEntryCount: 0,
    };
  }

  const entryDomains = (input.entryUrls || [])
    .map((entryUrl) => getPublisherDomain(entryUrl))
    .filter((domain): domain is string => domain !== null);
  const targetGroupId = getPublisherDomainGroupId(targetDomain);
  const feedGroupId = getPublisherDomainGroupId(feedDomain);
  const configuredDomainGroupMatch = targetGroupId !== null && targetGroupId === feedGroupId;
  const matchingEntryCount = entryDomains.filter((domain) =>
    domain === targetDomain || (
      configuredDomainGroupMatch && getPublisherDomainGroupId(domain) === targetGroupId
    )
  ).length;
  const foreignEntryCount = entryDomains.length - matchingEntryCount;

  if (entryDomains.length === 0) {
    return {
      allowed: false,
      reason: "missing_entry_evidence",
      feedDomain,
      targetDomain,
      inspectedEntryCount: 0,
      matchingEntryCount: 0,
      foreignEntryCount: 0,
    };
  }

  return {
    allowed: matchingEntryCount > 0 && foreignEntryCount === 0,
    reason: foreignEntryCount === 0 && matchingEntryCount > 0
      ? configuredDomainGroupMatch
        ? "verified_domain_group"
        : "verified_entry_domain"
      : "entry_domain_mismatch",
    feedDomain,
    targetDomain,
    inspectedEntryCount: entryDomains.length,
    matchingEntryCount,
    foreignEntryCount,
  };
}
