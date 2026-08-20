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
