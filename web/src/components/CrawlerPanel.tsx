import { useCallback, useEffect, useState } from 'react';
import { api, CrawlerStatus } from '../api';

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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="crawlstat">
      <span className="crawlstat__value">{value}</span>
      <span className="crawlstat__label">{label}</span>
      {hint && <span className="crawlstat__hint">{hint}</span>}
    </div>
  );
}

export default function CrawlerPanel() {
  const [status, setStatus] = useState<CrawlerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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

  if (!status) return <section><p className="hint">Asking the crawler…</p></section>;

  if (!status.reachable) {
    return (
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
    );
  }

  const pages = status.pages ?? {};
  const cycle = status.current ?? status.last ?? null;
  const cfg = status.config;

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
        </div>

        <div className="formrow" style={{ marginTop: '0.75rem' }}>
          <button onClick={() => void run()} disabled={busy || status.running}>
            {status.running ? 'Crawling…' : 'Crawl now'}
          </button>
          <button onClick={() => void load()}>Refresh</button>
          {message && <span className="hint" style={{ marginLeft: '0.5rem' }}>{message}</span>}
        </div>
      </section>

      <section>
        <h2>Last cycle</h2>
        {!cycle ? (
          <p className="hint">
            Nothing yet. The crawler waits to be told where to look — it takes the
            areas from Settings the first time the app asks it for events, so this
            fills in after the next refresh.
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

      {status.feedList && status.feedList.length > 0 && (
        <section>
          <h2>Calendar feeds it found</h2>
          <p className="hint">
            A feed is better than crawling the site that publishes it: it is
            structured, it carries a real timezone, and one address replaces a
            hundred pages. Paste any of these into Calendar feeds on the Sources
            tab.
          </p>
          <table className="crawltable crawltable--list">
            <thead>
              <tr><th>Site</th><th>Feed</th></tr>
            </thead>
            <tbody>
              {status.feedList.slice(0, 25).map((f) => (
                <tr key={f.url}>
                  <td>{f.site}</td>
                  <td><a href={f.url} target="_blank" rel="noreferrer">{f.url}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

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
              <td>{status.interests?.length ? status.interests.join(', ') : 'nothing yet'}</td>
              <td className="crawltable__note">taken from your areas</td>
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
