/**
 * Decode HTML entities in scraped text.
 *
 * Event titles arrive from feeds that HTML-encode punctuation, so a title can
 * reach the UI as "Swap Meet &#8211; Historic Car Club". Decoding via the
 * browser's own parser handles named and numeric entities alike; textContent is
 * read back, so no markup can survive into the DOM.
 */
export function decodeEntities(text: string): string {
  if (!text || !text.includes('&')) return text;
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

/**
 * Escapes special HTML characters (&, <, >, ", ') to prevent DOM XSS.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

/**
 * Verifies that a URL parses successfully and uses strictly http: or https: protocol.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

