import { defineStore } from "pinia";
import { ref } from "vue";
import { $api } from "~/utils/api";

export interface FeedArticle {
  id: number;
  title: string;
  source: string;
  sourceUrl?: string;
  date: string;
  score: number;
  isPaywall: boolean;
  tags: string[];
  reasoning: string;
  signals: string[];
}

const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

export const useFeedStore = defineStore("feed", () => {
  const articles = ref<FeedArticle[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<number | null>(null);

  const isCacheFresh = () =>
    lastFetchedAt.value !== null && Date.now() - lastFetchedAt.value < FEED_CACHE_TTL_MS;

  const fetchFeed = async (options?: { force?: boolean }) => {
    if (!options?.force && articles.value.length > 0 && isCacheFresh()) {
      return;
    }

    isLoading.value = true;
    error.value = null;
    try {
      const data = await $api<FeedArticle[]>("/api/feed");
      articles.value = data;
      lastFetchedAt.value = Date.now();
    } catch (err) {
      console.error("Error fetching feed:", err);
      error.value = "Failed to load feed.";
    } finally {
      isLoading.value = false;
    }
  };

  return {
    articles,
    isLoading,
    error,
    lastFetchedAt,
    fetchFeed,
  };
});
