import { db, getSettings } from '../db.js';
import { TaskLog, TaskResult } from '../tasks/registry.js';
import { chatJson, listModels, OllamaError } from './ollama.js';
import { flyerBacklog } from './visionPipeline.js';
import {
  buildPrompt,
  buildSchema,
  contentHash,
  EnrichInput,
  EnrichJob,
  readVerdict,
} from './schema.js';

/**
 * Reading the listings with a local model, as a background task.
 *
 * Deliberately not part of the event refresh. A pass of a few dozen events is a
 * minute or two of local inference, and a refresh that already carries a
 * thirty-minute watchdog is the wrong place to put it — a slow model would look
 * exactly like a hung source. On its own schedule it can take as long as it
 * likes without holding anything up.
 *
 * The cost of that is one cycle of latency: a venue the model reads out of a
 * description is picked up by the next refresh's geocoding pass rather than the
 * same one.
 */

/** Seconds one event may take before it is given up on. */
const EVENT_TIMEOUT_MS = 90_000;

interface Row {
  id: number;
  title: string;
  description: string;
  venue_name: string;
  address: string;
  category: string;
  start_time: string;
  source: string;
}

function toInput(row: Row): EnrichInput {
  return {
    title: row.title,
    description: row.description ?? '',
    venueName: row.venue_name ?? '',
    address: row.address ?? '',
    category: row.category ?? '',
    startTime: row.start_time,
    source: row.source,
  };
}

/**
 * Where Ollama is.
 *
 * The setting wins so it can be changed from the UI; `OLLAMA_URL` is the
 * default for a container, which cannot reach the host on localhost — that is
 * itself. Falls back to the ordinary local install.
 */
export function ollamaUrl(configured: string | undefined): string {
  return (configured || '').trim() || process.env.OLLAMA_URL || 'http://localhost:11434';
}

export function enabledJobs(): EnrichJob[] {
  const configured = getSettings().llmJobs ?? [];
  const known: EnrichJob[] = ['describe', 'classify', 'extract', 'score'];
  return known.filter((j) => configured.includes(j));
}

/**
 * Events worth spending inference on, oldest listing first.
 *
 * "Worth" means the stored fingerprint does not match what the row says now, so
 * this covers new events, edited ones, and everything already in the database
 * the first time the task runs. Archived rows are skipped: nobody is scouting a
 * shoot that has been and gone.
 *
 * Selected in bulk and filtered in memory rather than joined on the hash,
 * because the hash depends on settings the database knows nothing about.
 */
export function pendingEvents(model: string, jobs: EnrichJob[], limit: number): Row[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.description, e.venue_name, e.address, e.category,
              e.start_time, e.source, x.content_hash AS hash
         FROM events e
         LEFT JOIN event_enrichment x ON x.event_id = e.id
        WHERE e.archived = 0
        ORDER BY e.start_time`
    )
    .all() as unknown as (Row & { hash: string | null })[];

  const out: Row[] = [];
  for (const row of rows) {
    if (row.hash === contentHash(toInput(row), model, jobs)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** How many events are waiting, for the status display. */
export function backlogCount(): number {
  const settings = getSettings();
  const jobs = enabledJobs();
  if (jobs.length === 0) return 0;
  // Cheap enough at this scale, and only asked for when somebody is looking.
  return pendingEvents(settings.llmModel || '', jobs, Number.MAX_SAFE_INTEGER).length;
}

const recordStmt = () =>
  db.prepare(
    `INSERT INTO event_enrichment (event_id, content_hash, model, ok, note, enriched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       model = excluded.model,
       ok = excluded.ok,
       note = excluded.note,
       enriched_at = excluded.enriched_at`
  );

/**
 * One pass.
 *
 * Every failure mode ends the same way — the event keeps its scraped values and
 * the run carries on — because none of this is load-bearing. The one exception
 * is being unable to reach Ollama at all, which stops the pass rather than
 * failing every event in turn against a server that is not there.
 */
export async function runEnrichment(log: TaskLog): Promise<TaskResult> {
  const settings = getSettings();
  const jobs = enabledJobs();
  if (jobs.length === 0) return { ok: false, message: 'No enrichment jobs are switched on' };

  const url = ollamaUrl(settings.llmUrl);
  const model = settings.llmModel || '';
  if (!model) return { ok: false, message: 'No model chosen in Settings' };

  try {
    const installed = await listModels(url);
    if (!installed.some((m) => m.name === model)) {
      return {
        ok: false,
        message: `${model} is not installed on ${url} — try: ollama pull ${model}`,
      };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  const limit = Math.max(1, settings.llmMaxPerRun ?? 40);
  const rows = pendingEvents(model, jobs, limit);
  if (rows.length === 0) return { ok: true, message: 'nothing new to read' };

  const record = recordStmt();
  const update = db.prepare(
    `UPDATE events SET llm_description = ?, llm_category = ?, llm_venue_name = ?,
                       llm_address = ?, llm_price_text = ?, llm_photo_score = ?
     WHERE id = ?`
  );

  let done = 0;
  let failed = 0;
  const started = Date.now();
  log(`${rows.length} to read with ${model}`);

  for (const row of rows) {
    const input = toInput(row);
    const hash = contentHash(input, model, jobs);
    try {
      const raw = await chatJson({
        url,
        model,
        prompt: buildPrompt(input, jobs),
        // Per event, not per run: which fields it may answer depends on which
        // ones this listing left blank.
        schema: buildSchema(jobs, input),
        timeoutMs: EVENT_TIMEOUT_MS,
      });
      const verdict = readVerdict(raw, jobs);
      update.run(
        verdict.description ?? '',
        verdict.category ?? '',
        verdict.venueName ?? '',
        verdict.address ?? '',
        verdict.priceText ?? '',
        verdict.photoScore ?? null,
        row.id
      );
      record.run(row.id, hash, model, 1, '', new Date().toISOString());
      done++;
    } catch (err) {
      const message = (err as Error).message;
      failed++;
      // Remembered as tried, so one unreadable listing cannot hold up the
      // queue by being picked first every single run.
      record.run(row.id, hash, model, 0, message.slice(0, 200), new Date().toISOString());
      log(`${row.title}: ${message}`);
      // A server that has gone away will fail every remaining event the same
      // way; stop rather than spend the whole budget finding that out.
      if (err instanceof OllamaError && /cannot reach|No answer/i.test(message)) {
        return { ok: false, message: `${message} after ${done} event${done === 1 ? '' : 's'}` };
      }
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const left = backlogCount();
  log(`${done} read, ${failed} failed, ${seconds}s`);
  return {
    ok: failed < rows.length,
    message: `read ${done}${failed ? `, ${failed} failed` : ''} in ${seconds}s${left ? `, ${left} left` : ''}`,
  };
}

export interface LlmStatus {
  enabled: boolean;
  url: string;
  model: string;
  jobs: EnrichJob[];
  reachable: boolean;
  /** Why not, when unreachable. */
  problem: string;
  models: { name: string; size: number }[];
  modelInstalled: boolean;
  backlog: number;
  /** Events already read, so a reset can say what it is throwing away. */
  read: number;
  /** The flyer pass, which shares the server and the model list. */
  vision: {
    enabled: boolean;
    model: string;
    modelInstalled: boolean;
    backlog: number;
    read: number;
  };
}

export async function getLlmStatus(): Promise<LlmStatus> {
  const settings = getSettings();
  const url = ollamaUrl(settings.llmUrl);
  const jobs = enabledJobs();
  const base = {
    enabled: Boolean(settings.llmEnabled),
    url,
    model: settings.llmModel ?? '',
    jobs,
    backlog: jobs.length ? backlogCount() : 0,
    read: countRead('event_enrichment'),
    vision: {
      enabled: Boolean(settings.visionEnabled),
      model: settings.visionModel ?? '',
      modelInstalled: false,
      backlog: flyerBacklog(),
      read: countRead('event_vision'),
    },
  };
  try {
    const models = await listModels(url);
    return {
      ...base,
      reachable: true,
      problem: '',
      models,
      modelInstalled: models.some((m) => m.name === base.model),
      vision: { ...base.vision, modelInstalled: models.some((m) => m.name === base.vision.model) },
    };
  } catch (err) {
    return {
      ...base,
      reachable: false,
      problem: (err as Error).message,
      models: [],
      modelInstalled: false,
    };
  }
}

/** How many events a pass has already looked at. Table name is ours, not input. */
function countRead(table: 'event_enrichment' | 'event_vision'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Forget every verdict, so the next pass reconsiders everything. */
export function clearEnrichment(): number {
  const changed = db.prepare('DELETE FROM event_enrichment').run().changes;
  db.exec(
    `UPDATE events SET llm_description = '', llm_category = '', llm_venue_name = '',
                       llm_address = '', llm_price_text = '', llm_photo_score = NULL`
  );
  return Number(changed);
}
