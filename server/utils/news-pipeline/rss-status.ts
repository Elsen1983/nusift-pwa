import { RssStatus } from "@prisma/client";

export function normalizeActiveRssStatus(
  status: RssStatus,
  rssFeedUrl?: string | null,
) {
  if (status === RssStatus.ACTIVE && !rssFeedUrl) {
    return RssStatus.NO_RSS_FOUND;
  }

  return status;
}
