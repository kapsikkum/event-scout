/**
 * The calendar day an instant falls on, where the server is.
 *
 * `iso.slice(0, 10)` is the UTC day, which is the wrong day for a good share of
 * this database: a morning start here is the previous evening in UTC. Used
 * wherever events are grouped by day — the deduper, and the consensus that
 * picks a merged group's date — so that two listings for one Saturday land on
 * the same Saturday. The zone is the ambient one, which compose and the NixOS
 * unit both set with TZ.
 */
export function localDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
