import { useCallback, useEffect, useState } from 'react';
import { api, CrawlerHistoryRow, CrawlerPageRow, CrawlerStatus, CrawlPageReport, IcalPreview, Unauthorized } from '../api';
import { useStore } from '../store';

/**
 * What the crawler is doing, read from the crawler itself.
 *
 * Everything here is fetched through the server, which proxies it: the crawler
 * is deliberately not published to anything but the app, so the page has no
 * route of its own to it.
 *
 * Worth its own tab rather than a line on Sources because a crawl is a process
 * with a shape — a frontier that grows, pages that fail, sites that decline —
 * and none of that fits in the one-line status the other sources get.
 */

const NUMBER = new Intl.NumberFormat();

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/** A found event's start, as the rest of the app shows it: no hour it was not given. */
function whenOf(ev: { startTime: string; dateOnly?: boolean }): string {
  const at = new Date(ev.startTime);
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (ev.dateOnly) return day;
  return `${day} · ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="crawlstat">
      <span className="crawlstat__value">{value}</span>
      <span className="crawlstat__label">{label}</span>
      {hint && <span className="crawlstat__hint">{hint}</span>}
    </div>
  );
}

/** A round number at or above n, for an axis: 5, 10, 20, 25, 50, 100… */
function niceMax(n: number): number {
  if (n <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * mag >= n) return step * mag;
  return 10 * mag;
}

/** When a cycle ran, short: the time today, the day and time otherwise. */
function tickLabel(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (new Date().toDateString() === at.toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * The last day or so of cycles.
 *
 * Bars are what each cycle spent its budget on — pages read, and underneath the
 * red, pages that failed or that robots.txt declined. The orange line is what
 * that turned up. The two share an axis on purpose: a cycle of 200 pages and 3
 * events should look like one. The dashed line is the events held in all, on
 * its own axis to the right, because it is a running total and would flatten
 * everything else if it shared one.
 *
 * Plain SVG. One chart does not need a charting library, and the page stays
 * the size it was.
 */
function CrawlChart({ history }: { history: CrawlerHistoryRow[] }) {
  const W = 640;
  const H = 200;
  const L = 36;
  const R = 44;
  const T = 10;
  const B = 24;
  const pw = W - L - R;
  const ph = H - T - B;
  const n = history.length;

  const top = niceMax(Math.max(1, ...history.map((c) => c.fetched + c.failed + c.blocked), ...history.map((c) => c.events)));
  const heldTop = niceMax(Math.max(1, ...history.map((c) => c.finds)));
  const slot = pw / n;
  const bar = Math.max(2, Math.min(18, slot * 0.7));
  const x = (i: number): number => L + slot * i + slot / 2;
  const y = (v: number): number => T + ph - (v / top) * ph;
  const yHeld = (v: number): number => T + ph - (v / heldTop) * ph;
  const path = (get: (c: CrawlerHistoryRow) => number, scale: (v: number) => number): string =>
    history.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${scale(get(c)).toFixed(1)}`).join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelled = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const totalEvents = history.reduce((sum, c) => sum + c.events, 0);
  const totalPages = history.reduce((sum, c) => sum + c.fetched, 0);

  return (
    <figure className="crawlchart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Last ${n} cycles: ${totalPages} pages read, ${totalEvents} events found`}
      >
        {ticks.map((f) => (
          <g key={f}>
            <line className="crawlchart__grid" x1={L} x2={W - R} y1={T + ph - f * ph} y2={T + ph - f * ph} />
            <text className="crawlchart__axis" x={L - 6} y={T + ph - f * ph + 3} textAnchor="end">
              {NUMBER.format(Math.round(f * top))}
            </text>
            <text className="crawlchart__axis" x={W - R + 6} y={T + ph - f * ph + 3}>
              {NUMBER.format(Math.round(f * heldTop))}
            </text>
          </g>
        ))}

        {history.map((c, i) => {
          const trouble = c.failed + c.blocked;
          return (
            <g key={c.startedAt}>
              <rect
                className="crawlchart__read"
                x={x(i) - bar / 2}
                width={bar}
                y={y(c.fetched)}
                height={Math.max(0, T + ph - y(c.fetched))}
              />
              <rect
                className="crawlchart__trouble"
                x={x(i) - bar / 2}
                width={bar}
                y={y(c.fetched + trouble)}
                height={Math.max(0, y(c.fetched) - y(c.fetched + trouble))}
              />
            </g>
          );
        })}

        <path className="crawlchart__held" d={path((c) => c.finds, yHeld)} />
        <path className="crawlchart__events" d={path((c) => c.events, y)} />
        {history.map((c, i) => (
          <circle key={c.startedAt} className="crawlchart__dot" cx={x(i)} cy={y(c.events)} r={n > 40 ? 1.8 : 2.6} />
        ))}

        {labelled.map((i) => (
          <text
            key={i}
            className="crawlchart__axis"
            x={x(i)}
            y={H - 6}
            textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
          >
            {tickLabel(history[i].startedAt)}
          </text>
        ))}

        {/* One hover target per cycle, full height, carrying the whole story. */}
        {history.map((c, i) => (
          <rect key={c.startedAt} className="crawlchart__hit" x={L + slot * i} width={slot} y={T} height={ph}>
            <title>
              {`${new Date(c.startedAt).toLocaleString()}\n` +
                `${c.fetched} pages read, ${c.events} events found\n` +
                `${c.failed} failed, ${c.blocked} declined by robots.txt\n` +
                `${c.seeded} new pages from search, ${c.feeds} feeds seen\n` +
                `${NUMBER.format(c.queued)} queued, ${NUMBER.format(c.finds)} events held after`}
            </title>
          </rect>
        ))}
      </svg>
      <figcaption className="crawlchart__legend">
        <span><i className="crawlchart__key crawlchart__key--read" />pages read</span>
        <span><i className="crawlchart__key crawlchart__key--trouble" />failed or declined</span>
        <span><i className="crawlchart__key crawlchart__key--events" />events found</span>
        <span><i className="crawlchart__key crawlchart__key--held" />events held (right axis)</span>
      </figcaption>
    </figure>
  );
}

type PreviewState = IcalPreview | 'loading';

/** What is in one feed, under its row or under the address box. */
function FeedPreview({ state, added, onAdd }: { state: PreviewState; added: boolean; onAdd: () => void }) {
  if (state === 'loading') return <p className="hint">Reading the feed…</p>;
  if (!state.ok) return <p className="hint" style={{ color: 'var(--red)' }}>{state.message}</p>;
  const events = state.events ?? [];
  return (
    <div className="feedpreview">
      <p className="hint">
        <strong>{state.calendarName || 'Unnamed calendar'}</strong>
        {' — '}
        {NUMBER.format(state.total ?? 0)} event{state.total === 1 ? '' : 's'} in the file,{' '}
        {NUMBER.format(state.upcoming ?? 0)} from now to six months out
        {(state.upcoming ?? 0) > events.length ? `, the first ${events.length} shown` : ''}.{' '}
        {added ? (
          <span className="crawlfeeds__added">✓ In Calendar feeds</span>
        ) : (
          <button onClick={onAdd}>+ Add to Calendar feeds</button>
        )}
      </p>
      {events.length > 0 && (
        <table className="crawltable crawltable--wide">
          <thead>
            <tr><th>When</th><th>Event</th><th>Where</th></tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={`${ev.title}|${ev.startTime}`}>
                <td className="crawltable__when">{whenOf(ev)}</td>
                <td>{ev.url ? <a href={ev.url} target="_blank" rel="noreferrer">{ev.title}</a> : ev.title}</td>
                <td>{ev.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Calendar feeds: the ones the crawl came across, and any other address.
 *
 * A feed is better than crawling the site that publishes it — structured, with
 * a real timezone, one address in place of a hundred pages — but a feed URL
 * says nothing about what is in it. Preview reads it the way the Calendar feeds
 * source would, so what it shows is what adding it brings in; Add puts it on
 * that list without a trip to the Sources tab and a paste.
 */
function FeedsSection({ found }: { found: { url: string; site: string; foundOn: string }[] }) {
  const { settings, updateSettings, requestSignIn } = useStore();
  const [address, setAddress] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [note, setNote] = useState('');

  const added = new Set((settings?.icalFeeds ?? []).map((f) => f.url.trim()));
  const foundUrls = new Set(found.map((f) => f.url));

  const preview = async (url: string): Promise<void> => {
    if (open === url) {
      setOpen(null);
      return;
    }
    setOpen(url);
    const known = previews[url];
    if (known && known !== 'loading' && known.ok) return;
    setPreviews((p) => ({ ...p, [url]: 'loading' }));
    try {
      const answer = await api.icalPreview(url);
      setPreviews((p) => ({ ...p, [url]: answer }));
    } catch (err) {
      if (err instanceof Unauthorized) requestSignIn();
      const message = err instanceof Unauthorized ? 'Reading a feed needs the password.' : (err as Error).message;
      setPreviews((p) => ({ ...p, [url]: { url, ok: false, message } }));
    }
  };

  const add = async (url: string, fallbackName: string): Promise<void> => {
    if (!settings) return;
    const seen = previews[url];
    const name = (seen && seen !== 'loading' && seen.ok && seen.calendarName) || fallbackName;
    setNote('');
    try {
      await updateSettings({
        icalFeeds: [...settings.icalFeeds, { name, url }],
        // Adding a feed to a source that is switched off would do nothing.
        enabledSources: { ...settings.enabledSources, ical: true },
      });
      setNote(`Added “${name}” to Calendar feeds. Its events come in with the next refresh.`);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const manual = open && !foundUrls.has(open) ? open : null;

  return (
    <section>
      <h2>Calendar feeds</h2>
      <p className="hint">
        A feed is better than crawling the site that publishes it: it is
        structured, it carries a real timezone, and one address replaces a
        hundred pages. Preview one to see what it holds — read exactly as the
        Calendar feeds source would read it — and add the ones worth having.
      </p>
      <form
        className="formrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void preview(address.trim());
        }}
      >
        <input
          value={address}
          placeholder="https://…/events.ics or webcal://…"
          onChange={(e) => setAddress(e.target.value)}
        />
        <button type="submit" disabled={!address.trim()}>Preview</button>
      </form>
      {manual && previews[manual] && (
        <FeedPreview
          state={previews[manual]}
          added={added.has(manual)}
          onAdd={() => void add(manual, (() => { try { return new URL(manual.replace(/^webcals?:/i, 'https:')).hostname; } catch { return 'Calendar'; } })())}
        />
      )}
      {note && <p className="hint">{note}</p>}

      {found.length > 0 && (
        <>
          <h3 className="crawlsub">Found by the crawl ({found.length})</h3>
          <table className="crawltable crawltable--list">
            <thead>
              <tr><th>Site</th><th>Feed</th><th /></tr>
            </thead>
            <tbody>
              {found.slice(0, 50).map((f) => (
                <FeedRow
                  key={f.url}
                  feed={f}
                  isOpen={open === f.url}
                  state={previews[f.url]}
                  added={added.has(f.url)}
                  onPreview={() => void preview(f.url)}
                  onAdd={() => void add(f.url, f.site)}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function FeedRow({
  feed, isOpen, state, added, onPreview, onAdd,
}: {
  feed: { url: string; site: string };
  isOpen: boolean;
  state: PreviewState | undefined;
  added: boolean;
  onPreview: () => void;
  onAdd: () => void;
}) {
  return (
    <>
      <tr>
        <td>{feed.site}</td>
        <td><a href={feed.url} target="_blank" rel="noreferrer">{feed.url}</a></td>
        <td className="crawlfeeds__actions">
          <button onClick={onPreview}>{isOpen ? 'Hide' : 'Preview'}</button>
          {added ? <span className="crawlfeeds__added"> ✓ added</span> : <button onClick={onAdd}>Add</button>}
        </td>
      </tr>
      {isOpen && state && (
        <tr>
          <td colSpan={3}>
            <FeedPreview state={state} added={added} onAdd={onAdd} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Shorter to read in a table than the whole address. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${rest.length > 60 ? `${rest.slice(0, 57)}…` : rest}`;
  } catch {
    return url;
  }
}

/**
 * The pages the crawler has read, and how many times.
 *
 * A page read forty times is one the crawl keeps coming back to — a listing
 * that keeps producing, or a pinned site — and one read once that gave nothing
 * is one it has given up on. Most-read shows where the effort goes; latest
 * shows what it is doing now.
 */
function PagesSection() {
  const [sort, setSort] = useState<'reads' | 'recent'>('reads');
  const [pages, setPages] = useState<CrawlerPageRow[] | null>(null);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    try {
      const answer = await api.crawlerPages(sort);
      setPages(answer.pages);
      setProblem(answer.problem ?? '');
    } catch (err) {
      setProblem((err as Error).message);
    }
  }, [sort]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h2>Pages read</h2>
      <div className="formrow">
        <button className={sort === 'reads' ? 'primary' : ''} onClick={() => setSort('reads')}>Most read</button>
        <button className={sort === 'recent' ? 'primary' : ''} onClick={() => setSort('recent')}>Latest</button>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {problem && <p className="hint" style={{ color: 'var(--red)' }}>{problem}</p>}
      {pages && pages.length === 0 && !problem && <p className="hint">Nothing read yet.</p>}
      {pages && pages.length > 0 && (
        <table className="crawltable crawltable--wide">
          <thead>
            <tr><th>Page</th><th>Times read</th><th>Events</th><th>Last read</th><th /></tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.url}>
                <td><a href={p.url} target="_blank" rel="noreferrer" title={p.url}>{shortUrl(p.url)}</a></td>
                <td>{NUMBER.format(p.reads)}</td>
                <td>{p.events > 0 ? NUMBER.format(p.events) : '—'}</td>
                <td className="crawltable__when">{ago(p.fetchedAt)}</td>
                <td className="crawltable__note">{p.state === 'done' ? p.note : `${p.state}${p.note ? `: ${p.note}` : ''}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function CrawlerPanel() {
  const [status, setStatus] = useState<CrawlerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [reading, setReading] = useState(false);
  const [report, setReport] = useState<CrawlPageReport | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.crawlerStatus());
    } catch (err) {
      setStatus({ reachable: false, problem: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    // While a cycle is running the numbers move; the rest of the time this is
    // a page nobody is watching, so it polls slowly and only when it matters.
    const id = setInterval(() => void load(), 10000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const answer = await api.crawlerRun();
      setMessage(answer.message ?? 'started');
      setTimeout(() => void load(), 1500);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const read = async (): Promise<void> => {
    setReading(true);
    setReport(null);
    try {
      setReport(await api.crawlerCrawl(pageUrl.trim()));
      void load();
    } catch (err) {
      setReport({ url: pageUrl, ok: false, message: (err as Error).message, events: [], links: 0, feeds: [] });
    } finally {
      setReading(false);
    }
  };

  if (!status) return <section><p className="hint">Asking the crawler…</p></section>;

  if (!status.reachable) {
    return (
      <>
        <section>
          <h2>🕷 Crawler</h2>
          <p className="hint" style={{ color: 'var(--red)' }}>
            {status.problem ?? 'Cannot reach the crawler.'}
          </p>
          <p className="hint">
            It runs as its own container. With docker-compose it comes up alongside
            the app and needs no address set here; running it by hand, point the
            Crawler URL on the Sources tab at it.
          </p>
        </section>
        {/* Previewing a feed needs the server, not the crawler. */}
        <FeedsSection found={[]} />
      </>
    );
  }

  const pages = status.pages ?? {};
  const cycle = status.current ?? status.last ?? null;
  const cfg = status.config;
  const history = status.history ?? [];

  return (
    <>
      <section>
        <h2>
          🕷 Crawler
          <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: '0.85em', opacity: 0.75 }}>
            {status.running ? 'crawling now' : `last run ${ago(status.last?.finishedAt)}`}
          </span>
        </h2>

        <div className="crawlstats">
          <Stat label="events held" value={NUMBER.format(status.finds ?? 0)} hint="offered to the app" />
          <Stat label="queued" value={NUMBER.format(pages.queued ?? 0)} hint="pages waiting" />
          <Stat label="crawled" value={NUMBER.format(pages.done ?? 0)} hint="pages read" />
          <Stat label="declined" value={NUMBER.format(pages.skipped ?? 0)} hint="robots.txt and non-pages" />
          <Stat label="failed" value={NUMBER.format(pages.failed ?? 0)} hint="will be retried" />
          <Stat label="feeds found" value={NUMBER.format(status.feeds ?? 0)} hint="iCal, worth adding" />
          {status.social?.enabled && (
            <>
              <Stat
                label="Instagram posts"
                value={NUMBER.format(status.social.instagramPostsRead)}
                hint={`${NUMBER.format(status.social.instagramEvents)} with a date · ${NUMBER.format(status.social.instagramProfiles)} profiles`}
              />
              <Stat
                label="Facebook events"
                value={NUMBER.format(status.social.facebookEvents)}
                hint="read by the app"
              />
            </>
          )}
        </div>

        {history.length > 0 ? (
          <CrawlChart history={history} />
        ) : (
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            The graph starts with the first finished cycle.
          </p>
        )}

        <div className="formrow" style={{ marginTop: '0.75rem' }}>
          <button onClick={() => void run()} disabled={busy || status.running}>
            {status.running ? 'Crawling…' : 'Crawl now'}
          </button>
          <button onClick={() => void load()}>Refresh</button>
          {message && <span className="hint" style={{ marginLeft: '0.5rem' }}>{message}</span>}
        </div>
      </section>

      <section>
        <h2>Read a page now</h2>
        <p className="hint">
          Any address — a venue&apos;s what&apos;s-on, a council calendar, a link
          someone sent you. It is read straight away, obeying robots.txt as the
          crawl does, and its own links go into the queue so the rest of that
          site is followed on the next cycle. To have a page read regularly, add
          it to <em>Sites to crawl</em> on the Sources tab.
        </p>
        <form
          className="formrow"
          onSubmit={(e) => {
            e.preventDefault();
            void read();
          }}
        >
          <input value={pageUrl} placeholder="https://…" onChange={(e) => setPageUrl(e.target.value)} />
          <button type="submit" disabled={reading || !pageUrl.trim()}>
            {reading ? 'Reading…' : 'Read it'}
          </button>
        </form>
        {report && (
          <div style={{ marginTop: '0.6rem' }}>
            <p className="hint" style={report.ok ? undefined : { color: 'var(--red)' }}>
              {report.message}
              {report.ok && ` ${report.links} link${report.links === 1 ? '' : 's'} queued for the next cycle.`}
              {report.ok && report.reads
                ? ` Read ${report.reads === 1 ? 'once' : `${NUMBER.format(report.reads)} times`} so far.`
                : ''}
              {report.ok && report.feeds.length > 0 &&
                ` ${report.feeds.length} calendar feed${report.feeds.length === 1 ? '' : 's'} found — preview ${report.feeds.length === 1 ? 'it' : 'them'} under Calendar feeds.`}
            </p>
            {report.events.length > 0 && (
              <table className="crawltable crawltable--wide">
                <thead>
                  <tr><th>When</th><th>Event</th><th>Where</th></tr>
                </thead>
                <tbody>
                  {report.events.slice(0, 50).map((ev) => (
                    <tr key={`${ev.title}|${ev.startTime}`}>
                      <td className="crawltable__when">{whenOf(ev)}</td>
                      <td>
                        {ev.url ? <a href={ev.url} target="_blank" rel="noreferrer">{ev.title}</a> : ev.title}
                      </td>
                      <td>{ev.venueName ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <FeedsSection found={status.feedList ?? []} />

      <section>
        <h2>What it looks for</h2>
        <p className="hint">
          Your topics and extra search terms, searched in each of your areas —
          the same list web search uses, set on the Sources tab. There are more
          phrases than it is worth searching at once, so it takes a different
          handful each hour and works round the whole list; these are this
          hour&apos;s. From every result it follows that site&apos;s own links,
          reading pages that publish <code>schema.org</code> event data and noting
          any calendar feed.
        </p>
        {status.social?.enabled && (
          <p className="hint">
            It also follows links out to Instagram and Facebook, which is where
            most small events are announced. An Instagram post becomes an event
            when its caption names a date on or after the day it was posted;
            profiles are looked at once a day for new posts. Facebook event links
            are handed to the app, which reads them with its Facebook reader.
            Both sites ask crawlers to stay out in robots.txt — this reads them
            anyway, slowly, and <code>CRAWLER_SOCIAL=false</code> on the crawler
            container turns it off.
          </p>
        )}
        {!status.interests?.length ? (
          <p className="hint">Nothing yet — set a location on the General tab and save.</p>
        ) : (
          <table className="crawltable crawltable--wide">
            <thead>
              <tr><th>Area</th><th>Searching this hour</th><th>Phrases in all</th></tr>
            </thead>
            <tbody>
              {status.interests.map((i) => (
                <tr key={i.city}>
                  <td>{i.city}</td>
                  <td>
                    <ul className="crawlphrases">
                      {i.thisCycle.map((phrase) => <li key={phrase}>{phrase}</li>)}
                    </ul>
                  </td>
                  <td>{i.terms > 0 ? i.terms : 'none set — a general list'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3 className="crawlsub">Sites it reads every six hours</h3>
        {status.seeds?.length ? (
          <ul className="crawlphrases">
            {status.seeds.map((u) => (
              <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>
            ))}
          </ul>
        ) : (
          <p className="hint">None. Add addresses under <em>Sites to crawl</em> on the Sources tab.</p>
        )}
      </section>

      <section>
        <h2>Last cycle</h2>
        {!cycle ? (
          <p className="hint">
            Nothing yet. It is told where to look whenever settings are saved,
            and starts a cycle within a minute or two of having somewhere to
            look — or press Crawl now.
          </p>
        ) : (
          <table className="crawltable">
            <tbody>
              <tr>
                <th>Started</th>
                <td>{new Date(cycle.startedAt).toLocaleString()}</td>
                <td className="crawltable__note">{status.running ? 'still going' : ago(cycle.finishedAt)}</td>
              </tr>
              <tr>
                <th>Pages read</th>
                <td>{NUMBER.format(cycle.fetched)}</td>
                <td className="crawltable__note">of {NUMBER.format(cfg?.maxPagesPerRun ?? 0)} allowed</td>
              </tr>
              <tr>
                <th>Events found</th>
                <td>{NUMBER.format(cycle.events)}</td>
                <td className="crawltable__note">
                  {cycle.fetched > 0 ? `${(cycle.events / cycle.fetched).toFixed(2)} per page` : ''}
                </td>
              </tr>
              <tr>
                <th>New pages seeded</th>
                <td>{NUMBER.format(cycle.seeded)}</td>
                <td className="crawltable__note">from search, when the queue runs low</td>
              </tr>
              <tr>
                <th>Blocked</th>
                <td>{NUMBER.format(cycle.blocked)}</td>
                <td className="crawltable__note">robots.txt said no</td>
              </tr>
              <tr>
                <th>Failed</th>
                <td>{NUMBER.format(cycle.failed)}</td>
                <td className="crawltable__note">timeouts, errors, pages that were not HTML</td>
              </tr>
            </tbody>
          </table>
        )}
        {cycle && cycle.lines.length > 0 && (
          <details style={{ marginTop: '0.6rem' }}>
            <summary className="hint">What did not work ({cycle.lines.length})</summary>
            <pre className="crawllog">{cycle.lines.join('\n')}</pre>
          </details>
        )}
      </section>

      <PagesSection />

      <section>
        <h2>How it is set up</h2>
        <p className="hint">
          Environment variables on the crawler container, not settings here —
          they govern how hard it crawls, which is a property of the machine it
          runs on rather than of what you are looking for.
        </p>
        <table className="crawltable">
          <tbody>
            <tr>
              <th>Looking for</th>
              <td>{status.interests?.length ? status.interests.map((i) => i.city).join(', ') : 'nothing yet'}</td>
              <td className="crawltable__note">your location and areas</td>
            </tr>
            <tr>
              <th>Pages per cycle</th>
              <td>{NUMBER.format(cfg?.maxPagesPerRun ?? 0)}</td>
              <td className="crawltable__note">CRAWLER_MAX_PAGES</td>
            </tr>
            <tr>
              <th>Link depth</th>
              <td>{cfg?.maxDepth ?? '—'}</td>
              <td className="crawltable__note">how far from a seed it follows a site&apos;s own links</td>
            </tr>
            <tr>
              <th>Politeness</th>
              <td>{((cfg?.minHostDelayMs ?? 0) / 1000).toFixed(1)}s</td>
              <td className="crawltable__note">
                minimum between two requests to one site, and never two at once
              </td>
            </tr>
            <tr>
              <th>Runs every</th>
              <td>{cfg?.intervalMinutes ?? '—'} min</td>
              <td className="crawltable__note">CRAWLER_INTERVAL_MIN</td>
            </tr>
            <tr>
              <th>Identifies as</th>
              <td colSpan={2}><code>{cfg?.userAgent ?? '—'}</code></td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
