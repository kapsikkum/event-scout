import { db, getSettings } from '../db.js';
import { TaskLog, TaskResult } from '../tasks/registry.js';
import { chatJson, listModels, OllamaError } from './ollama.js';
import { ollamaUrl } from './pipeline.js';
import {
  buildVisionPrompt,
  fetchImage,
  ImageError,
  readVisionVerdict,
  thumbnailFor,
  visionHash,
  VISION_NUM_CTX,
  VISION_SCHEMA,
} from './vision.js';

/** A flyer takes fifteen to twenty-five seconds, so the budget is smaller. */
const EVENT_TIMEOUT_MS = 120_000;

interface Row {
  id: number;
  title: string;
  image_url: string;
  venue_name: string;
  address: string;
  price_text: string;
}

/**
 * Events whose flyer is worth reading.
 *
 * Only those missing something the flyer could supply. Two thirds of the
 * listings here have an image and no price, which is the gap this exists to
 * close; reading the other third to confirm what is already known would be
 * hours of inference for nothing.
 */
export function pendingFlyers(model: string, limit: number): Row[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.image_url, e.venue_name, e.address, e.price_text,
              v.content_hash AS hash
         FROM events e
         LEFT JOIN event_vision v ON v.event_id = e.id
        WHERE e.archived = 0
          AND length(e.image_url) > 0
          AND (length(e.venue_name) = 0 OR length(e.address) = 0 OR length(e.price_text) = 0)
        ORDER BY e.start_time`
    )
    .all() as unknown as (Row & { hash: string | null })[];

  const out: Row[] = [];
  for (const row of rows) {
    if (row.hash === visionHash({ title: row.title, imageUrl: row.image_url }, model)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function flyerBacklog(): number {
  return pendingFlyers(getSettings().visionModel || '', Number.MAX_SAFE_INTEGER).length;
}

/**
 * One pass over the flyers.
 *
 * Every failure leaves the event exactly as it was and the run carries on. The
 * exception is losing the model server, which would fail every remaining flyer
 * the same way.
 */
export async function runVisionPass(log: TaskLog): Promise<TaskResult> {
  const settings = getSettings();
  const url = ollamaUrl(settings.llmUrl);
  const model = settings.visionModel || '';
  if (!model) return { ok: false, message: 'No vision model chosen in Settings' };

  try {
    const installed = await listModels(url);
    if (!installed.some((m) => m.name === model)) {
      return { ok: false, message: `${model} is not installed on ${url} — try: ollama pull ${model}` };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  const limit = Math.max(1, settings.visionMaxPerRun ?? 20);
  const rows = pendingFlyers(model, limit);
  if (rows.length === 0) return { ok: true, message: 'no flyers left to read' };

  const record = db.prepare(
    `INSERT INTO event_vision (event_id, content_hash, model, ok, note, read_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       content_hash = excluded.content_hash, model = excluded.model,
       ok = excluded.ok, note = excluded.note, read_at = excluded.read_at`
  );
  const update = db.prepare(
    `UPDATE events SET vision_venue_name = ?, vision_address = ?,
                       vision_price_text = ?, vision_note = ?
     WHERE id = ?`
  );

  let read = 0;
  let filled = 0;
  let failed = 0;
  const started = Date.now();
  log(`${rows.length} flyer${rows.length === 1 ? '' : 's'} to read with ${model}`);

  for (const row of rows) {
    const input = { title: row.title, imageUrl: row.image_url };
    const hash = visionHash(input, model);
    try {
      const image = await fetchImage(thumbnailFor(row.image_url));
      const raw = await chatJson({
        url,
        model,
        prompt: buildVisionPrompt(input),
        schema: VISION_SCHEMA,
        images: [image],
        numCtx: VISION_NUM_CTX,
        timeoutMs: EVENT_TIMEOUT_MS,
      });
      const v = readVisionVerdict(raw);
      update.run(v.venueName ?? '', v.address ?? '', v.priceText ?? '', v.note ?? '', row.id);
      record.run(row.id, hash, model, 1, '', new Date().toISOString());
      read++;
      // Only what the event was actually missing counts as useful.
      if ((!row.venue_name && v.venueName) || (!row.address && v.address) || (!row.price_text && v.priceText)) {
        filled++;
      }
    } catch (err) {
      const message = (err as Error).message;
      failed++;
      // An unreadable flyer is remembered as tried, so it cannot be picked
      // first on every subsequent run and hold up the queue behind it.
      record.run(row.id, hash, model, 0, message.slice(0, 200), new Date().toISOString());
      log(`${row.title}: ${message}`);
      if (err instanceof OllamaError && /cannot reach|No answer/i.test(message)) {
        return { ok: false, message: `${message} after ${read} flyer${read === 1 ? '' : 's'}` };
      }
      if (err instanceof ImageError) continue;
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const left = flyerBacklog();
  log(`${read} read, ${filled} filled a blank, ${failed} failed, ${seconds}s`);
  return {
    ok: failed < rows.length,
    message: `read ${read}, filled ${filled}${failed ? `, ${failed} failed` : ''} in ${seconds}s${left ? `, ${left} left` : ''}`,
  };
}

/** Forget every flyer verdict, so the next pass looks again. */
export function clearVision(): number {
  const changed = db.prepare('DELETE FROM event_vision').run().changes;
  db.exec(
    `UPDATE events SET vision_venue_name = '', vision_address = '',
                       vision_price_text = '', vision_note = ''`
  );
  return Number(changed);
}
