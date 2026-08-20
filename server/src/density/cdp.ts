import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { sleep } from './http.js';
import { USER_AGENT, USER_AGENT_METADATA } from '../useragent.js';
import { STEALTH_ARGS, STEALTH_SCRIPT, WINDOW_SIZE } from './stealth.js';

/**
 * A very small Chrome DevTools Protocol client.
 *
 * Google's "Popular times" panel is rendered client-side, so reading it needs a
 * real browser. Rather than pull in Playwright and a 300 MB browser download,
 * this drives the Edge or Chrome already installed on the machine using only
 * Node's built-in `fetch` and `WebSocket`.
 */

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser(explicit?: string | null): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Browser path does not exist: ${explicit}`);
    return explicit;
  }
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Edge or Chrome found. Set the browser path in settings.');
  return found;
}

interface LaunchOpts {
  browserPath?: string | null;
  headless?: boolean;
  port?: number;
  /** Reused between runs. See the note in launch(). */
  profileDir: string;
}

/**
 * Kill any browser still holding a profile directory.
 *
 * The launcher process exits immediately and hands off to a fresh tree, so
 * killing a spawned pid misses the real browser and leaks renderer, GPU and
 * network-service children. Matching on the profile directory is reliable and
 * safe: that path is unique to us, so this can never touch the user's browser.
 */
export function killProfileHolders(profileDir: string): void {
  const marker = basename(profileDir);
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { stdio: 'ignore', timeout: 10000 }
      );
    } else {
      execFileSync('pkill', ['-f', `user-data-dir=${profileDir}`], { stdio: 'ignore' });
    }
  } catch {
    // Nothing left to kill.
  }
}

/**
 * Clear the singleton locks a browser leaves behind when it is killed rather
 * than closed. A stale lock makes the next launch exit instantly, which shows
 * up as "did not expose a debugging port" - the browser was never really up.
 */
export function clearProfileLocks(profileDir: string): void {
  if (!existsSync(profileDir)) return;
  try {
    for (const entry of readdirSync(profileDir)) {
      if (/^(Singleton|lockfile)/i.test(entry)) {
        rmSync(join(profileDir, entry), { force: true, recursive: true });
      }
    }
  } catch {
    // Best effort; a genuinely running browser will still hold its lock.
  }
}

export class Browser {
  /** Tabs this client opened, so a shared browser can be handed them back. */
  private opened: string[] = [];

  constructor(
    /** Null when the browser is a service we attached to rather than started. */
    private proc: ChildProcess | null,
    public port: number,
    public profileDir: string,
    /** Where the DevTools HTTP endpoint lives. */
    public base = `http://127.0.0.1:${port}`
  ) {}

  get remote(): boolean {
    return this.proc === null;
  }

  /**
   * Attach to a browser already running somewhere else — in Docker, the
   * chromium service next door.
   *
   * The hostname is resolved to an address before anything is requested,
   * because Chrome rejects a DevTools request whose Host header is a name
   * ("Host header is specified and is not an IP address or localhost") and
   * under Compose the endpoint is a service name. Resolving here keeps the
   * configuration readable and the request acceptable.
   */
  static async connect(endpoint: string): Promise<Browser> {
    const url = new URL(endpoint);
    const port = Number(url.port || 9222);

    // Every address the name resolves to, not just the first. "localhost"
    // resolves to ::1 ahead of 127.0.0.1 on most systems while a browser
    // typically binds one family only, so taking the first answer picks the
    // wrong one about half the time — which presents as a browser that is
    // plainly running but "did not expose a debugging port".
    const resolved = await lookup(url.hostname, { all: true }).catch(() => []);
    const hosts = resolved.length
      ? resolved.map((r) => (r.family === 6 ? `[${r.address}]` : r.address))
      : [url.hostname];

    let lastErr: unknown;
    for (const host of hosts) {
      const browser = new Browser(null, port, '', `http://${host}:${port}`);
      try {
        // Generous on the last candidate, because under `docker compose up`
        // the browser and the app start together and the browser is slower.
        await browser.waitForReady(host === hosts[hosts.length - 1] ? 60_000 : 2000);
        return browser;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `Could not reach a browser at ${endpoint}. ${(lastErr as Error)?.message ?? ''}`
    );
  }

  static async launch(opts: LaunchOpts): Promise<Browser> {
    const exe = findBrowser(opts.browserPath);
    // The profile is deliberately persistent. A browser that arrives with no
    // cookies at all, every single time, is exactly what an automated client
    // looks like, and Google answers it with a stripped-down "limited view"
    // that omits popular times entirely. Keeping the profile lets ordinary
    // consent and preference cookies accumulate the way a real browser's do.
    // It is still our own profile, entirely separate from the user's browser.
    mkdirSync(opts.profileDir, { recursive: true });

    const args = (port: number) => [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${opts.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-gpu',
      '--mute-audio',
      `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
      `--user-agent=${USER_AGENT}`,
      ...STEALTH_ARGS,
      'about:blank',
      ...(opts.headless !== false ? ['--headless=new'] : []),
    ];

    // Two attempts: a leftover browser or a stale lock from a killed one will
    // make the first exit instantly, and clearing both fixes it.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        killProfileHolders(opts.profileDir);
        clearProfileLocks(opts.profileDir);
        await sleep(1500);
      }
      const port = opts.port ?? 9500 + Math.floor(Math.random() * 400);
      const proc = spawn(exe, args(port), { stdio: 'ignore' });
      const browser = new Browser(proc, port, opts.profileDir);
      try {
        await browser.waitForReady();
        return browser;
      } catch (err) {
        lastErr = err;
        try { proc.kill(); } catch { /* already gone */ }
      }
    }
    throw new Error(
      `Could not start the browser. ${(lastErr as Error)?.message ?? ''} ` +
      'A previous instance may still be holding its profile.'
    );
  }

  private async waitForReady(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/json/version`);
        if (res.ok) return;
      } catch {
        // Not listening yet.
      }
      await sleep(200);
    }
    throw new Error(`Browser did not expose a debugging port on ${this.port}`);
  }

  /**
   * Rewrite a target's socket URL to point at the endpoint we actually reached.
   *
   * A remote browser describes its own sockets as living on localhost, which
   * is true from where it is standing and useless from here.
   */
  private socketUrl(wsUrl: string): string {
    const target = new URL(this.base);
    const ws = new URL(wsUrl);
    ws.host = target.host;
    return ws.toString();
  }

  async newPage(): Promise<Page> {
    // A shared browser gets a tab of its own rather than adopting whatever
    // was already open, which might belong to another run.
    if (this.remote) {
      const created = (await (
        await fetch(`${this.base}/json/new?about:blank`, { method: 'PUT' })
      ).json()) as { id?: string; webSocketDebuggerUrl?: string };
      if (!created?.webSocketDebuggerUrl) throw new Error('Remote browser would not open a page');
      if (created.id) this.opened.push(created.id);
      return this.dress(await Page.connect(this.socketUrl(created.webSocketDebuggerUrl)));
    }

    const list = (await (await fetch(`${this.base}/json/list`)).json()) as {
      type: string; webSocketDebuggerUrl?: string;
    }[];
    let target = list.find((t) => t.type === 'page');
    if (!target) {
      await fetch(`${this.base}/json/new?about:blank`, { method: 'PUT' });
      await sleep(300);
      const again = (await (await fetch(`${this.base}/json/list`)).json()) as {
        type: string; webSocketDebuggerUrl?: string;
      }[];
      target = again.find((t) => t.type === 'page');
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page target');
    return this.dress(await Page.connect(target.webSocketDebuggerUrl));
  }

  /**
   * Give a fresh page its identity before anything is loaded into it.
   *
   * Done here rather than left to callers: a page that forgets is a page that
   * introduces itself as a headless Chromium on Linux, and the resulting
   * failure is silent — Google answers a suspect client with a Maps view that
   * simply omits popular times, which looks like a venue with no data.
   */
  private async dress(page: Page): Promise<Page> {
    await page.setUserAgent();
    await page.hardenAgainstDetection();
    return page;
  }

  /**
   * Chrome holds an exclusive lock on its profile directory, so a persistent
   * profile cannot be reused until every process has exited. Await this before
   * launching again with the same directory.
   */
  /**
   * Ask the browser to shut itself down, over the protocol.
   *
   * Chrome only writes its cookie and local-storage databases to disk on a
   * clean exit. Killing the process instead throws away whatever it had not
   * flushed, which is why a profile that had just been signed in came back
   * empty on the next launch. `Browser.close` gives it the chance to finish.
   */
  private async requestShutdown(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/json/version`);
      const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (!webSocketDebuggerUrl) return false;
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('browser socket failed')), { once: true });
        setTimeout(() => reject(new Error('browser socket timeout')), 3000);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(250);
      try { ws.close(); } catch { /* already closing */ }
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // A browser we merely attached to belongs to someone else. Closing it
    // would take the container down for every later refresh, so give back the
    // tabs and leave it running.
    if (this.remote) {
      for (const id of this.opened.splice(0)) {
        try {
          await fetch(`${this.base}/json/close/${id}`);
        } catch {
          // Already gone.
        }
      }
      return;
    }

    const exited = new Promise<void>((resolve) => {
      if (this.proc!.exitCode !== null) return resolve();
      this.proc!.once('exit', () => resolve());
      setTimeout(resolve, 8000);
    });

    const asked = await this.requestShutdown();
    // Only force it if it would not go quietly; see requestShutdown().
    if (!asked) {
      try { this.proc!.kill('SIGTERM'); } catch { /* already gone */ }
    }
    await exited;
    killProfileHolders(this.profileDir);
    clearProfileLocks(this.profileDir);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class Page {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private events = new Map<string, ((params: unknown) => void)[]>();

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.events.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }

  static async connect(url: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Page(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method: string, cb: (params: unknown) => void): void {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method)!.push(cb);
  }

  async goto(url: string, { waitMs = 3500 }: { waitMs?: number } = {}): Promise<void> {
    await this.send('Page.enable');
    const loaded = new Promise<void>((resolve) => {
      this.on('Page.loadEventFired', () => resolve());
      setTimeout(resolve, 20000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    // Popular times is painted after load, so give the client a moment.
    await sleep(waitMs);
  }

  /**
   * Poll an expression until it is truthy, or give up.
   *
   * Better than a fixed sleep after navigation: Google paints the popular-times
   * panel well after load, and how long it takes varies with the place. A flat
   * wait long enough for the slowest page wastes that time on all the others,
   * and one tuned to the average silently drops data for the rest.
   */
  async waitFor(
    expression: string, { timeoutMs = 12000, everyMs = 400 }: { timeoutMs?: number; everyMs?: number } = {}
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate(`String(Boolean(${expression}))`)) === 'true') return true;
      } catch {
        // Still navigating; the next poll will find a live context.
      }
      await sleep(everyMs);
    }
    return false;
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression: string): Promise<string | undefined> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: string }; exceptionDetails?: { exception?: { description?: string } } };
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return res.result?.value;
  }

  /**
   * Present the page as Edge on Windows 11.
   *
   * The metadata matters as much as the string: without it the browser keeps
   * answering `navigator.userAgentData` from the real platform, so a page that
   * asks for high-entropy client hints is told Linux by one channel and
   * Windows by the other. Since the browser moved into a container that is no
   * longer a hypothetical — the truthful answer there is a headless Chromium
   * on X11.
   */
  /**
   * Install the anti-detection preamble and square up the properties that CDP
   * controls better than page script can. See stealth.ts.
   */
  async hardenAgainstDetection(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SCRIPT });
    // A viewport reported as 800x600 — or as 0x0, which headless does when
    // nothing sets it — is as clear a tell as the user agent was.
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Claiming en-AU from a container running UTC is a contradiction. TZ is
    // set in compose and defaults to the machine's own zone elsewhere.
    const timezone = process.env.TZ?.trim();
    if (timezone) {
      try {
        await this.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      } catch {
        // An unrecognised zone id is not worth failing a scrape over.
      }
    }
  }

  async setUserAgent(ua: string = USER_AGENT, locale = 'en-AU'): Promise<void> {
    await this.send('Network.enable');
    await this.send('Network.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: locale,
      platform: 'Win32',
      userAgentMetadata: USER_AGENT_METADATA,
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Get a browser, however one is available.
 *
 * BROWSER_CDP_URL points at a browser running as a service — that is how the
 * Docker setup works, where Chromium is its own container and nothing in the
 * app image could launch a browser even if it wanted to. Unset, it behaves as
 * it always has and starts one locally.
 */
export async function openBrowser(opts: LaunchOpts): Promise<Browser> {
  const remote = process.env.BROWSER_CDP_URL?.trim();
  return remote ? Browser.connect(remote) : Browser.launch(opts);
}
