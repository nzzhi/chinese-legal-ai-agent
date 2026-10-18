/** The one escaping/URL-safety implementation; `link` is a security control, so two copies could diverge. */
const replacements: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => replacements[character]!)
export const markdownText = (text: string) => escapeHtml(text).replace(/[\\`*_[\]{}#|]/g, '\\$&')

/** A source link is rendered only when it is a plain http(s) URL carrying no credentials. */
export function safeSourceLink(url: string): string {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsafe report source link')
  return parsed.href
}
