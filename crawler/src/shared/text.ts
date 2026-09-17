/**
 * Turning what a page published into plain, tidy text. See README.md in this
 * directory.
 */

/** Placeholders that sources put in the address field instead of leaving it empty. */
export const NOT_AN_ADDRESS = /^(tba|tbc|tbd|n\/?a|none|null|undefined|online|virtual|to be (announced|confirmed)|see (website|link|below)|various( locations)?)$/i;

/**
 * Restore a name that arrived shouting.
 *
 * "169 COLLEGE ROAD" is how one source writes every address, and it reads as
 * a shout next to every other line on the card. Only strings with no lowercase
 * letter at all are touched, so a name that deliberately mixes case keeps
 * whatever it chose. Words of three letters or fewer stay upper — RSL, NSW,
 * BMW and GP are acronyms, not shouting — and a word glued to a digit
 * ("FIT4ALL") is left alone, since that is a brand rather than a sentence.
 */
export function titleCaseShouting(text: string): string {
  if (!text || /[a-z]/.test(text)) return text;
  return text.replace(/[\p{L}][\p{L}'’]*/gu, (word) =>
    word.length <= 3 ? word : word[0] + word.slice(1).toLowerCase()
  );
}

/**
 * Named entities worth knowing without pulling in a parser. Event blurbs are
 * punctuation-heavy — curly quotes, en dashes, ellipses — and everything else
 * a feed emits is numeric.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', deg: '°', trade: '™',
  copy: '©', reg: '®', eacute: 'é', middot: '·', bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Turn a scraped description into plain text.
 *
 * Feeds hand over whatever their CMS stored: WordPress ships block comments
 * and <p> wrappers, others ship a "read more" anchor mid-sentence, and several
 * carry the two characters backslash-n where a line break belongs — all of
 * which the detail panel showed verbatim, tags and all.
 *
 * Entities are decoded before tags are stripped, so a description that arrived
 * double-escaped ("&lt;p&gt;") loses its markup too rather than displaying it
 * as text. Paragraph and break tags become blank lines; everything else simply
 * goes, since the panel renders plain text.
 */
export function cleanDescription(description: string | undefined): string {
  if (!description) return '';
  return decodeEntities(description)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    // Not newlines but the two literal characters, straight out of a JSON
    // field that was embedded in another JSON field somewhere upstream.
    .replace(/(?:\\r)?\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One line of text — a title, a venue, a price — as plain text: entities
 * decoded, tags and emoji-only clutter left to cleanDescription, runs of space
 * and line breaks folded to one space. '' when nothing is left.
 */
export function cleanLine(text: string | undefined): string {
  return cleanDescription(text).replace(/\s+/g, ' ').trim();
}
