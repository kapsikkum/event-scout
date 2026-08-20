# 📸 Event Scout

A local web app that aggregates upcoming events in your area from multiple sources, scored and filterable for photography scouting. Everything runs and stays on your machine — API keys and the event cache live in a local SQLite database.

## Quick start

```powershell
npm install
npm run dev        # dev mode: server on :3001, UI on http://localhost:5173
```

or for a single production process:

```powershell
npm run build
npm start          # serves the UI + API on http://localhost:3001
```

On first launch you'll land on **Settings**: search for your city (OpenStreetMap geocoding), pick a radius, configure whichever sources you want, then **Save & refresh now**. Every source is optional — the app works with any subset.

## Event sources

| Source | What you need | Notes |
|---|---|---|
| **Ticketmaster** | Free API key from [developer.ticketmaster.com](https://developer.ticketmaster.com/) | Concerts, sports, theater. 5,000 calls/day free. |
| **SeatGeek** | Free client ID from [seatgeek.com/account/develop](https://seatgeek.com/account/develop) | Complements Ticketmaster. |
| **Eventbrite** | Private token from [eventbrite.com/platform/api-keys](https://www.eventbrite.com/platform/api-keys) + organizer IDs | Eventbrite removed public search; you follow specific organizers (the number in `eventbrite.com/o/name-1234567890`). |
| **Facebook** | Optional logged-in cookie | **Unofficial scraper** — see warning below. |
| **Web search** | Nothing (search terms optional) | **Unofficial scraper** — queries DuckDuckGo/Bing and extracts `schema.org/Event` data from result pages. See note below. |
| **iCal feeds** | Feed URLs | Many city tourism sites, parks departments, and venues publish `.ics` calendars — great for festivals and free events. |

### ⚠️ The Facebook source

Meta removed public event search from its official API in 2018, so this source scrapes facebook.com instead (event search + the event tabs of Pages you list). **This violates Meta's Terms of Service**, can break whenever Facebook changes its markup, and could in principle get the logged-in account restricted — consider a throwaway account. It works far better with a session cookie: log in to facebook.com → F12 → Application → Cookies → copy `c_user` and `xs` into Settings as `c_user=…; xs=…`. A failed Facebook fetch never affects the other sources; its status is shown per-source in Settings.

### 🔎 The Web search source

This source needs no API key. For each search term it queries DuckDuckGo (falling back to Bing), follows the top results, and extracts structured `schema.org/Event` JSON-LD embedded in those pages — the same metadata Google uses for event rich-results. It's most valuable for the long tail that the ticketing APIs miss: individual venues, civic/tourism calendars, university and library event pages. Notes:

- It reads **structured data only**, not free-text snippets, so results are clean (real title, time, venue, coordinates) — but only pages that publish that markup contribute.
- Large aggregators that block scrapers or omit JSON-LD (Facebook, Songkick, Bandsintown, Ticketmaster, etc.) are skipped automatically; blocked/empty pages are counted and reported in the source status, never fatal.
- Search engines may rate-limit heavy scraping. Leave the terms empty to auto-search your city, or add specific terms like `live music this weekend <city>` or a venue name.

## Features

- **Events** — card grid with date chips (today / weekend / 7 days / month), category/source filters, text search, and sorts: soonest, **best for photos**, nearest. Online-only events are hidden by default.
- **Photo score** — a keyword/category heuristic that ranks events by photographic appeal (festivals, parades, air shows, markets, fireworks rank high; webinars rank zero).
- **Shortlist** — star events, then export the shortlist as `.ics` to drop onto your real calendar.
- **Map** — dark Leaflet map with pins colored by category; starred events ringed in amber.
- **Calendar** — month grid; click a day to see its events.
- **Dedupe** — the same event found by multiple sources is merged into one card (normalized title + date + venues within 300 m), with all source links shown.
- **Auto-refresh** — refreshes on launch when the cache is older than 6 h, and hourly in the background; manual Refresh button in the header.

## Architecture

npm workspaces: `server/` (Express + TypeScript, SQLite via Node's built-in `node:sqlite`, one adapter per source in `server/src/sources/`) and `web/` (React + Vite). The dev server proxies `/api` to the backend; the production server serves the built UI itself. Set `API_PORT` to change the backend port (default 3001).

## Venue density

Density sampling runs as one of event-scout's background tasks, on its own
schedule alongside the event sources. Enable it under **Settings → Venue
density**.

It is deliberately a separate schedule from the event refresh: events change a
few times a day, but venue busyness is only meaningful sampled every 30-60
minutes. A timer ticks every 5 minutes and the job decides whether the
configured interval has elapsed, so changing the interval takes effect
immediately without a restart.

| Setting | Meaning |
|---|---|
| `densityEnabled` | Off by default. Each pass opens one page per venue. |
| `densityIntervalMinutes` | 15–240, default 60. |
| `densityCities` | Blank means every city traffic-density has configured. |

Two manual actions are available: **Sample now** forces a pass, and **Rebuild
venue list** re-runs discovery (slow, and rarely needed — the venue list barely
changes, unlike its busyness). Concurrent passes are refused rather than queued,
so a long run cannot stack up behind the timer.

Routes: `/api/density/status`, `POST /api/density/refresh`, `POST /api/density/discover`.

If `TRAFFIC_DENSITY_URL` is set, scheduling is skipped entirely — that remote
instance is responsible for its own scraping.

## Density map (traffic-density)

The Map view can overlay live venue busyness and a density grid from the
sibling [traffic-density](../traffic-density) project: density heat underneath,
venue markers scaled by how full each place is, and your event pins on top, each
toggleable.

It resolves in two ways, and needs no configuration in the common case:

- **Local (default)** — reads the co-located `../traffic-density` directly.
- **Remote** — set `TRAFFIC_DENSITY_URL=http://host:8787` to use that project's
  JSON API instead, so the two can run on separate machines.

If the remote is unreachable it falls back to the local copy, and if neither is
present the map simply shows events as before. The density layer enhances
event-scout; it is never a dependency.

Routes: `/api/density/cities`, `/api/density/:city`, `/api/density/:city/venues`.

To share one location between the tools, set `eventScout.enabled` in
traffic-density's `config.json` and it will read the city configured here.

## Event archiving

Past events are archived rather than deleted. `refreshAll()` archives anything
that finished more than a day ago, stamping `archived_at`. Starred events are
kept indefinitely; unstarred archived events are purged after 730 days so the
database stays bounded.

- `GET /api/events` — upcoming (the default)
- `GET /api/events?archived=1` — history, newest first
- `POST /api/archive` — run archiving on demand

## Running in Docker

Two containers: the app, and a Chromium the app drives over the DevTools
protocol for the parts of the density layer that need a real browser.

```bash
docker compose up --build
```

Then open <http://localhost:3001>. The database lives in the `event-scout-data`
volume and the browser profile in `chromium-profile`, so both survive a rebuild.

Set the timezone — it decides when an event counts as past — in a `.env` file
next to `docker-compose.yml`:

```
TZ=Australia/Sydney
```

### How the browser is wired up

`BROWSER_CDP_URL` is the whole switch. Set, `openBrowser()` attaches to a
browser already running at that address; unset, it launches one locally, which
is what happens when you run outside Docker. Nothing else changes.

The CDP port is not published to the host. Anything that can reach an open
DevTools port can drive the browser, read its cookies, and fetch local files
through it, so it stays on the compose network.

### Not looking like a bot

Google answers a client it suspects with a Maps view that omits popular times
entirely, which reads as "this venue has no data" — the failure is silent, so
it is worth getting right.

- `server/src/useragent.ts` is the single source of truth for the user agent.
  Every scraper and every page share it, along with matching `sec-ch-ua` client
  hints; a request whose UA string and client hints disagree is a clearer
  signal than either would be alone. It claims Edge on Windows 11. Bump `MAJOR`
  when it starts to look old — being a few versions behind is ordinary, being
  ahead of what exists is not.
- `server/src/density/stealth.ts` closes the rest: `navigator.webdriver`, the
  software-renderer WebGL strings, the missing `window.chrome`, an empty plugin
  list, and a viewport no real window has. It is applied to every page
  automatically by `Browser.newPage()`, so no caller can forget it.
- The browser container runs a full Chromium in `--headless=new` rather than
  the smaller `headless-shell` image, which has the browser parts compiled out
  and is correspondingly easy to spot. See `Dockerfile.chromium`.

None of this makes detection impossible — anything running in the page can be
checked against something that is not. If scrapes start coming back empty,
assume the arms race moved rather than that something here broke.
