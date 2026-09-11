/**
 * Folding the crawler's old listings into one per event.
 *
 * The crawler used to key a find on the page it read it on, so one event on its
 * own page, a calendar and a dozen suburb pages arrived here as a dozen rows —
 * merged into one card, but as "16 listings", and every refresh added to them.
 * It now keys a find on the event's own link, title and start. This works out,
 * for the rows already stored, which of them are the same find under that key,
 * so they can be folded once and the next refresh update the one left rather
 * than adding beside it.
 *
 * Pure, so it can be tested without a database. See db.ts for where it runs.
 */

export interface CrawlerRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  start_time: string;
  starred: number;
  hidden: number;
  manual_group: string;
  /** Every edit_* text column, concatenated: '' means none were edited. */
  edits: string;
  edit_photo_score: number | null;
}

/** The id the crawler source now gives the same listing. See sources/crawler.ts. */
export const crawlerRowKey = (row: Pick<CrawlerRow, 'url' | 'title' | 'start_time'>): string =>
  `crawl:${row.url}#${row.title.toLowerCase()}|${row.start_time}`.slice(0, 400);

export interface CollapsePlan {
  keep: number;
  key: string;
  remove: number[];
  starred: number;
  hidden: number;
}

const touched = (row: CrawlerRow): boolean =>
  Boolean(row.starred || row.hidden || row.manual_group || row.edits || row.edit_photo_score != null);

/**
 * What to keep, what to drop, and what to rename.
 *
 * The row kept is one someone has touched — starred, hidden, merged or edited —
 * where there is one, so nothing done by hand is lost; otherwise the oldest.
 * Stars and removals on the rows dropped carry over to it.
 */
export function planCollapse(rows: CrawlerRow[]): CollapsePlan[] {
  const byKey = new Map<string, CrawlerRow[]>();
  for (const row of rows) {
    const key = crawlerRowKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const plans: CollapsePlan[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    const keep = sorted.find(touched) ?? sorted[0];
    const remove = sorted.filter((r) => r !== keep).map((r) => r.id);
    if (remove.length === 0 && keep.source_id === key) continue;
    plans.push({
      keep: keep.id,
      key,
      remove,
      starred: list.some((r) => r.starred) ? 1 : 0,
      hidden: list.some((r) => r.hidden) ? 1 : 0,
    });
  }
  return plans;
}
