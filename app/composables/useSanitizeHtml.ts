/**
 * useSanitizeHtml
 *
 * Two-layer HTML sanitisation:
 *   1. **Server (SSR)** – strips ALL tags, returns plain text.
 *      Eliminates any XSS surface during server-side rendering.
 *   2. **Client (browser)** – DOMPurify with a minimal allow-list
 *      that covers only the formatting a news article actually needs.
 *
 * The composable auto-detects the runtime via `import.meta.server`.
 */
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'

/* ------------------------------------------------------------------ */
/*  MINIMAL ALLOW-LIST – only what a news article body genuinely needs */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = [
  // Block structure
  'p', 'br', 'h2', 'h3', 'h4',
  'blockquote', 'pre', 'hr',
  // Lists
  'ul', 'ol', 'li',
  // Inline formatting
  'strong', 'em', 'b', 'i', 'u', 'mark',
  'code',
  // Links
  'a',
  // Media
  'img', 'figure', 'figcaption',
  // Semantic
  'time',
]

const ALLOWED_ATTR = [
  // Links – href must pass the URI scheme filter below
  'href', 'target', 'rel',
  // Images
  'src', 'alt', 'width', 'height', 'loading',
  // time element
  'datetime',
  // Minimal layout helpers
  'class',
]

/* ------------------------------------------------------------------ */
/*  SERVER-SIDE: tag-stripping regex (no DOM dependency)               */
/* ------------------------------------------------------------------ */

const HTML_TAG = /<\/?[^>]+(>|$)/g
const HTML_ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);?/gi

/** Decode common HTML entities after stripping tags. */
function decodeEntities(raw: string): string {
  const map: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  }
  return raw.replace(HTML_ENTITY, (_match, name: string) => {
    if (map[name]) return map[name]!
    if (name.startsWith('#x')) return String.fromCharCode(parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCharCode(parseInt(name.slice(1), 10))
    return ''
  })
}

/** Strip every HTML tag and decode entities → safe plain text. */
export function stripAllTags(dirty: string): string {
  if (!dirty) return ''
  // Remove <script> and <style> blocks entirely (content + tags)
  const withoutScripts = dirty.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  const withoutStyles = withoutScripts.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  // Strip remaining tags
  const stripped = withoutStyles.replace(HTML_TAG, '')
  return decodeEntities(stripped).trim()
}

/* ------------------------------------------------------------------ */
/*  CLIENT-SIDE: DOMPurify configuration                               */
/* ------------------------------------------------------------------ */

const PURIFY_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Only https and mailto – no http, javascript:, data:, vbscript:, etc.
  ALLOWED_URI_REGEXP: /^(?:(?:https):|mailto:[^@]+@[^.]+\.[^]+)/i,
  ALLOW_DATA_ATTR: false,
}

/**
 * Hook: after sanitisation, force `rel="noopener noreferrer"` on every
 * external link. Only targets links whose href starts with http(s).
 * Internal / anchor links are left untouched.
 *
 * Guarded against duplicate registration (HMR, repeated module loads).
 */
if (typeof window !== 'undefined' && !(globalThis as any).__purifyHookRegistered) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const anchor = node as HTMLAnchorElement
      const href = anchor.getAttribute('href') || ''
      // Only enforce target/rel on external links
      if (href.startsWith('https://')) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
      }
    }
  })
  ;(globalThis as any).__purifyHookRegistered = true
}

/* ------------------------------------------------------------------ */
/*  CLIENT-SIDE SANITISE (exported for direct testing)                 */
/* ------------------------------------------------------------------ */

/** Sanitise HTML using DOMPurify – client path only. */
export function sanitizeClient(dirty: string): string {
  if (!dirty) return ''
  return DOMPurify.sanitize(dirty, PURIFY_CONFIG)
}

/* ------------------------------------------------------------------ */
/*  PUBLIC COMPOSABLE API                                              */
/* ------------------------------------------------------------------ */

export function useSanitizeHtml() {
  /**
   * Sanitise an untrusted HTML string.
   * - **Server**: returns plain text (all tags stripped).
   * - **Client**: returns sanitised HTML via DOMPurify.
   */
  function sanitize(dirty: string): string {
    if (!dirty) return ''

    if (import.meta.server) {
      // Server: never emit raw HTML — plain text only
      return stripAllTags(dirty)
    }

    return sanitizeClient(dirty)
  }

  return { sanitize }
}
