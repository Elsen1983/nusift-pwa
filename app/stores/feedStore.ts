// stores/feedStore.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { $api } from '~/utils/api'

export interface FeedArticle {
  id: number
  title: string
  source: string
  sourceUrl?: string
  date: string
  score: number
  isPaywall: boolean
  tags: string[]
  reasoning: string
  signals: string[]
}

export const useFeedStore = defineStore('feed', () => {
  // Állapotok (State)
  const articles = ref<FeedArticle[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // Műveletek (Actions)
  const fetchFeed = async () => {
    isLoading.value = true
    error.value = null
    try {
      // A Nuxt beépített $fetch függvénye automatikusan ismeri a server/api végpontokat
      const data = await $api<FeedArticle[]>('/api/feed')
      articles.value = data
    } catch (err) {
      console.error('Error fetching feed:', err)
      error.value = 'Failed to load feed.'
    } finally {
      isLoading.value = false
    }
  }

  return {
    articles,
    isLoading,
    error,
    fetchFeed
  }
})
