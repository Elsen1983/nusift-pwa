export const PUBLISHER_DOMAIN_GROUPS = [
  {
    id: "bbc",
    domains: ["bbc.com", "bbc.co.uk", "bbci.co.uk"],
  },
] as const;

export function getPublisherDomainGroupId(domain: string): string | null {
  const normalized = domain.toLowerCase();
  return PUBLISHER_DOMAIN_GROUPS.find((group) =>
    group.domains.some((candidate) => candidate === normalized)
  )?.id ?? null;
}
