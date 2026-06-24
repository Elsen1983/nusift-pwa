/**
 * useSanitizeHtml – sanitisation unit tests.
 *
 * Tests exercise the two core functions directly:
 *   - sanitizeClient: DOMPurify-based client sanitisation
 *   - stripAllTags: server-side plain-text fallback
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { JSDOM } from 'jsdom'

let sanitizeClient: typeof import('./useSanitizeHtml').sanitizeClient
let stripAllTags: typeof import('./useSanitizeHtml').stripAllTags

beforeAll(async () => {
  // Set up a minimal DOM so DOMPurify can initialise
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Node', dom.window.Node)
  vi.stubGlobal('HTMLAnchorElement', dom.window.HTMLAnchorElement)

  const mod = await import('./useSanitizeHtml')
  sanitizeClient = mod.sanitizeClient
  stripAllTags = mod.stripAllTags
})

/* ================================================================== */
/*  CLIENT-SIDE: DOMPurify (sanitizeClient)                           */
/* ================================================================== */

describe('sanitizeClient – XSS payload rejection', () => {
  it('strips <script> tags and their content', () => {
    const dirty = '<p>Hello</p><script>alert(1)</script>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('alert')
    expect(result).toContain('Hello')
  })

  it('strips inline event handlers (onclick)', () => {
    const dirty = '<div onclick="alert(1)">Click me</div>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('alert')
    expect(result).toContain('Click me')
  })

  it('strips onerror on <img>', () => {
    const dirty = '<img src="x" onerror="alert(1)">'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('onerror')
    expect(result).not.toContain('alert')
  })

  it('blocks javascript: URIs in links', () => {
    const dirty = '<a href="javascript:alert(1)">click</a>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('javascript:')
    expect(result).not.toContain('alert')
    expect(result).toContain('click')
  })

  it('blocks data: URIs in images', () => {
    const dirty = '<img src="data:text/html,<script>alert(1)</script>" alt="x">'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('data:')
    expect(result).not.toContain('alert')
  })

  it('blocks vbscript: URIs', () => {
    const dirty = '<a href="vbscript:MsgBox">click</a>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('vbscript:')
    expect(result).toContain('click')
  })

  it('strips <style> tags and their content', () => {
    const dirty = '<p>Text</p><style>body{background:red}</style>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<style>')
    expect(result).not.toContain('background')
    expect(result).toContain('Text')
  })

  it('strips <iframe> tags', () => {
    const dirty = '<p>Safe</p><iframe src="https://evil.com"></iframe>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<iframe>')
    expect(result).not.toContain('evil.com')
    expect(result).toContain('Safe')
  })

  it('strips <svg> with embedded script', () => {
    const dirty = '<svg onload="alert(1)"><circle r="10"/></svg>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<svg')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('alert')
  })

  it('strips <object> and <embed> tags', () => {
    const dirty = '<object data="evil.swf"></object><embed src="evil.swf">'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<object')
    expect(result).not.toContain('<embed')
  })

  it('blocks http:// links (only https allowed)', () => {
    const dirty = '<a href="http://insecure.com">Link</a>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('http://')
    expect(result).toContain('Link')
  })

  it('strips data-* attributes', () => {
    const dirty = '<p data-xss="evil" class="ok">Text</p>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('data-xss')
    expect(result).toContain('class="ok"')
  })

  it('strips disallowed structural tags (div, span, nav, h1, h5, h6)', () => {
    const dirty = '<h1>Nope</h1><div><span>Maybe</span><nav>Nav</nav></div>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('<h1>')
    expect(result).not.toContain('<div>')
    expect(result).not.toContain('<span>')
    expect(result).not.toContain('<nav>')
    expect(result).toContain('Nope')
    expect(result).toContain('Maybe')
  })

  it('strips id and role attributes (not in allowlist)', () => {
    const dirty = '<p id="steal" role="button">Text</p>'
    const result = sanitizeClient(dirty)
    expect(result).not.toContain('id=')
    expect(result).not.toContain('role=')
    expect(result).toContain('Text')
  })
})

describe('sanitizeClient – safe HTML preservation', () => {
  it('preserves paragraph tags', () => {
    const result = sanitizeClient('<p>Article text</p>')
    expect(result).toContain('<p>')
    expect(result).toContain('Article text')
  })

  it('preserves bold and italic formatting', () => {
    const result = sanitizeClient('<p><strong>Bold</strong> and <em>italic</em></p>')
    expect(result).toContain('<strong>')
    expect(result).toContain('<em>')
  })

  it('preserves safe https links with rel noopener noreferrer', () => {
    const result = sanitizeClient('<a href="https://example.com">Link</a>')
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain('target="_blank"')
    expect(result).toContain('rel="noopener noreferrer"')
  })

  it('preserves images with safe src', () => {
    const result = sanitizeClient('<img src="https://example.com/photo.jpg" alt="Photo" width="300">')
    expect(result).toContain('<img')
    expect(result).toContain('src="https://example.com/photo.jpg"')
    expect(result).toContain('alt="Photo"')
  })

  it('preserves lists', () => {
    const result = sanitizeClient('<ul><li>Item 1</li><li>Item 2</li></ul>')
    expect(result).toContain('<ul>')
    expect(result).toContain('<li>')
    expect(result).toContain('Item 1')
  })

  it('preserves headings h2-h4', () => {
    const result = sanitizeClient('<h2>Title</h2><h3>Subtitle</h3><h4>Sub-sub</h4>')
    expect(result).toContain('<h2>')
    expect(result).toContain('<h3>')
    expect(result).toContain('<h4>')
  })

  it('preserves blockquote and pre', () => {
    const result = sanitizeClient('<blockquote>Quote</blockquote><pre>Code</pre>')
    expect(result).toContain('<blockquote>')
    expect(result).toContain('<pre>')
  })

  it('preserves mailto links', () => {
    const result = sanitizeClient('<a href="mailto:user@example.com">Email</a>')
    expect(result).toContain('mailto:user@example.com')
    expect(result).toContain('Email')
  })

  it('handles empty input gracefully', () => {
    expect(sanitizeClient('')).toBe('')
  })
})

/* ================================================================== */
/*  SERVER-SIDE: stripAllTags                                          */
/* ================================================================== */

describe('stripAllTags – server-side plain-text fallback', () => {
  it('strips all HTML tags', () => {
    expect(stripAllTags('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('removes <script> blocks entirely', () => {
    const result = stripAllTags('<p>Safe</p><script>document.cookie</script>')
    expect(result).toBe('Safe')
    expect(result).not.toContain('cookie')
  })

  it('removes <style> blocks entirely', () => {
    const result = stripAllTags('<p>Text</p><style>body{color:red}</style>')
    expect(result).toBe('Text')
  })

  it('decodes HTML entities', () => {
    expect(stripAllTags('Hello &amp; world')).toBe('Hello & world')
    expect(stripAllTags('&lt;div&gt;')).toBe('<div>')
    expect(stripAllTags('Quote: &quot;hello&quot;')).toBe('Quote: "hello"')
  })

  it('strips nested and malformed tags', () => {
    const result = stripAllTags('<div><span><b>Deep</b></span></div>')
    expect(result).toBe('Deep')
  })

  it('returns empty string for empty input', () => {
    expect(stripAllTags('')).toBe('')
  })

  it('returns plain text unchanged', () => {
    expect(stripAllTags('Just plain text')).toBe('Just plain text')
  })

  it('handles broken/incomplete tags', () => {
    const result = stripAllTags('Hello < broken > world')
    expect(result).toContain('Hello')
    expect(result).toContain('world')
  })
})
