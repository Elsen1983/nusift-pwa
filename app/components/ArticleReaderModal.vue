<template>
  <transition 
    enter-active-class="transition duration-300 ease-out" 
    enter-from-class="opacity-0 translate-y-4" 
    enter-to-class="opacity-100 translate-y-0" 
    leave-active-class="transition duration-200 ease-in" 
    leave-from-class="opacity-100 translate-y-0" 
    leave-to-class="opacity-0 translate-y-4"
  >
    <div v-if="modelValue && article" class="fixed inset-0 z-[130] bg-background overflow-y-auto">
      <div class="min-h-screen flex flex-col max-w-3xl mx-auto relative bg-background">
        <div class="sticky top-0 z-20 flex justify-end p-4 bg-gradient-to-b from-background via-background/90 to-transparent">
          <button @click="$emit('update:modelValue', false)" class="w-10 h-10 bg-surface-container-highest rounded-full flex items-center justify-center text-on-surface-variant hover:text-on-surface border border-outline-variant/30 shadow-lg">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div class="px-6 pb-24 pt-2 flex-1 flex flex-col relative">
          <div class="flex items-center gap-2 mb-4">
            <span class="font-label text-[10px] uppercase tracking-widest text-primary-container font-bold">
              {{ $t('articleReaderModal.badge_preview') }}
            </span>
          </div>
          <h1 class="font-headline text-2xl md:text-3xl font-bold text-on-surface mb-6 leading-tight">{{ article.title }}</h1>
          
          <ClientOnly>
            <div class="font-body text-sm md:text-base text-on-surface-variant leading-relaxed space-y-5" v-html="sanitizedContent"></div>
            <template #fallback>
              <div class="font-body text-sm md:text-base text-on-surface-variant leading-relaxed space-y-5">{{ strippedContent }}</div>
            </template>
          </ClientOnly>

          <div class="mt-8 flex justify-center">
            <button
              @click="$emit('browser')"
              class="w-full max-w-[320px] py-3 px-4 bg-primary-container text-on-primary-container hover:brightness-110 font-bold rounded-xl text-[14px] uppercase tracking-wider shadow-md shadow-primary-container/20"
            >
              {{ $t('articleReaderModal.btn_browser') }}
            </button>
          </div>
          
          <div v-if="article.isPaywall" class="absolute bottom-0 left-0 w-full h-[400px] bg-gradient-to-t from-background via-background/95 to-transparent flex flex-col items-center justify-end pb-12 px-6 z-10">
            <div class="pointer-events-auto flex flex-col items-center w-full pb-12">
              <div class="w-14 h-14 bg-surface-container-lowest rounded-full flex items-center justify-center mb-5 border border-outline-variant/20">
                <span class="material-symbols-outlined text-[28px] text-primary-container" :style="{ fontVariationSettings: '\'FILL\' 1' }">lock</span>
              </div>
              <h3 class="font-headline text-on-surface font-bold text-[16px] mb-2 text-center">
                {{ $t('articleReaderModal.paywall_title') }}
              </h3>
              <button @click="$emit('browser')" class="w-full max-w-[280px] py-3 px-4 bg-primary-container text-on-primary-container hover:brightness-110 font-bold rounded-xl text-[14px] uppercase tracking-wider shadow-md shadow-primary-container/20">
                {{ $t('articleReaderModal.btn_browser') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { stripAllTags } from '~/composables/useSanitizeHtml'

const props = defineProps<{ modelValue: boolean, article: any, content: string }>();
defineEmits(['update:modelValue', 'browser']);

const { sanitize } = useSanitizeHtml()

// Client-side: DOMPurify-sanitised HTML (safe for v-html)
const sanitizedContent = computed(() => sanitize(props.content))

// SSR fallback: plain-text for the <ClientOnly> #fallback slot (no HTML, no XSS)
const strippedContent = computed(() => stripAllTags(props.content || ''))
</script>
