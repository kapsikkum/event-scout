import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeping a copy of the flyers.
 *
 * Two reasons, and the smaller one is the one people expect. Pictures do rot —
 * Facebook's CDN signs its URLs and they start answering 403 — but measured
 * across 1,085 of them only 3% had gone, and all of those were Facebook. So
 * this is not mainly an archive against loss.
 *
 * It is mainly that the app already downloads every one of them. The flyer pass
 * fetches each image to read it, and re-fetches the lot whenever the prompt
 * version changes. A local copy makes a re-read free and stops the app pulling
 * the same megabyte off somebody else's CDN every time it changes its mind.
 *
 * Filed by the date of the event, because that is how a person looking for one
 * would go about it. An event's date can change — a source corrects it, or
 * someone edits it — so `refile` moves the copy rather than leaving it under a
 * day the event is no longer on.
 *
 * Kept for as long as the event is worth keeping: shortlisted events are never
 * purged, so their flyers live indefinitely, and everything else is dropped
 * once the event is past and the cache has stopped earning its space.
 */

/**
 * Content types worth storing, and what to call them on disk.
 *
 * AVIF earns its place the hard way: allevents' CDN content-negotiates and
 * serves it, so leaving it out refused a fifth of everything on offer as "not
 * an image". Every type here is one a browser can display, which is the only
 * requirement — these are served straight back to the page.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

/** Every extension this store writes. One list, so nothing drifts out of step. */
export const FLYER_EXTENSIONS = [...new Set(Object.values(EXTENSIONS))];

export function extensionFor(contentType: string): string | null {
  return EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] ?? null;
}

/**
 * The file name for an image, derived from its address.
 *
 * A hash rather than anything from the listing: two events often share a
 * picture, the same URL must always land on the same file, and a title makes a
 * poor file name in any case.
 */
export function flyerName(imageUrl: string, extension: string): string {
  const hash = crypto.createHash('sha1').update(imageUrl).digest('hex').slice(0, 16);
  return `${hash}.${extension}`;
}

/**
 * The day an event is filed under: its start date, in the server's own zone.
 *
 * Local rather than UTC on purpose. The stored time is UTC, and slicing that
 * puts a 10am event on the previous day for a quarter of this database — the
 * same confusion that had the deduper bucketing events on the wrong date.
 */
export function flyerDay(startTime: string): string {
  const at = new Date(startTime);
  if (Number.isNaN(at.getTime())) return 'undated';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Where a copy lives, relative to the flyer root. Always day/name. */
export function flyerRelative(day: string, name: string): string {
  return `${day}/${name}`;
}

/**
 * The address the page fetches a stored copy from.
 *
 * Both halves are encoded: they end up in a URL, and the route that reads them
 * checks their shape again before touching the disk.
 */
export function flyerHref(relative: string): string {
  return `/api/flyer/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Whether a day and name are shapes this app could have written.
 *
 * The route reads both straight out of a URL, so they are checked rather than
 * trusted: nothing but a date and a hashed name, and no path separators or dots
 * that could climb out of the directory.
 */
export function isSafeFlyerPath(day: string, name: string): boolean {
  // The dot is escaped twice over: once for the string, once for the pattern.
  // Written `\.` in a template literal it collapses to a bare dot, which
  // matches any character at all.
  const named = new RegExp(`^[0-9a-f]{16}\\.(${FLYER_EXTENSIONS.join('|')})$`);
  return /^(\d{4}-\d{2}-\d{2}|undated)$/.test(day) && named.test(name);
}

/** The store itself, rooted wherever the caller keeps its data. */
export class FlyerStore {
  constructor(private readonly root: string) {}

  absolute(relative: string): string {
    return path.join(this.root, relative);
  }

  has(relative: string): boolean {
    return fs.existsSync(this.absolute(relative));
  }

  write(relative: string, bytes: Buffer): void {
    const target = this.absolute(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written aside and renamed, so a half-downloaded file is never served: a
    // rename within a directory is atomic and a partial write is not.
    const temporary = `${target}.part`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  }

  remove(relative: string): boolean {
    const target = this.absolute(relative);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target);
    return true;
  }

  /** Move a copy to the day the event is now on. Returns whether it moved. */
  refile(from: string, to: string): boolean {
    if (from === to) return false;
    const source = this.absolute(from);
    if (!fs.existsSync(source)) return false;
    const target = this.absolute(to);
    if (fs.existsSync(target)) {
      // Already filed correctly by another listing sharing the picture.
      fs.rmSync(source);
      return true;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return true;
  }

  /** Every stored copy, as day/name paths. */
  list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    const out: string[] = [];
    for (const day of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.part')) continue;
        out.push(flyerRelative(day, name));
      }
    }
    return out;
  }

  /** Drop day directories left with nothing in them. */
  tidy(): void {
    if (!fs.existsSync(this.root)) return;
    for (const day of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }

  bytes(): number {
    let total = 0;
    for (const relative of this.list()) {
      try {
        total += fs.statSync(this.absolute(relative)).size;
      } catch {
        // Removed between listing and measuring; nothing to add.
      }
    }
    return total;
  }
}
