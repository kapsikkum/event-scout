# Zenith deployment

How Event Scout runs on [Zenith](https://zenith.hosting): the facts about this
app. The Zenith rules themselves come from the skill at
`.agents/skills/create-zenith-compose/SKILL.md`.

## What runs

`zenith-compose.yml` at the root runs the same three images as
`docker-compose.yml`, each pinned to an image digest.

| Service | Image | Built from | Port | Storage |
|---|---|---|---|---|
| `app` | `ghcr.io/kapsikkum/event-scout` | `Dockerfile` | 3001, public | `event-scout-data` at `/app/data` |
| `crawler` | `ghcr.io/kapsikkum/event-scout-crawler` | `Dockerfile.crawler` | 3002, private | `crawler-data` at `/app/data` |
| `chromium` | `ghcr.io/kapsikkum/event-scout-chromium` | `Dockerfile.chromium` | 9222, private | `chromium-profile` at `/profile` |

Every image is `linux/amd64`, built from the repository root as the build
context. `app` serves plain HTTP on 3001; Zenith puts TLS in front of it.

- **Settings asked for:** `AUTH_PASSWORD` (required, secret) and `TZ`
  (defaults to `Australia/Sydney`). Nothing else is needed to start.
- **Wired between services:** `BROWSER_CDP_URL=http://chromium:9222`,
  `CRAWLER_URL=http://crawler:3002`.
- **Left out:** `OLLAMA_URL`. The local-model tasks are off by default and
  need an Ollama the deployment can reach; set its address in Settings.
- **No mail.** The app sends notifications to Discord and Matrix, not email,
  so there is no SMTP to configure.
- **Not verified on Zenith:** `shm_size` on `chromium` is not in Zenith's
  documented list of honoured fields. Without it Chromium may crash on heavy
  pages; the app keeps working, but venue busyness sampling will fail.

The browser profile holds Chromium's cache as well as its cookies, which is
most of its size (2 GB on a long-running install).

## Checking it

`bash scripts/zenith-smoke.sh [manifest]` boots a manifest's stack with a test
password and checks the page loads, `/api/version` answers, the app reaches the
crawler, and the browser answers the app. It needs Docker with Compose.

CI (`.github/workflows/ci.yml`):

- **`zenith`, on every pull request:** builds all three images for
  `linux/amd64` from the pull request, and runs the smoke test on the manifest
  with those images swapped in. On a push to `main` it validates the manifest.
- **`zenith-update`, after `images` on `main`:** runs
  `scripts/zenith-prepare-image-update.sh`. It verifies the new `sha-<commit>`
  images without registry credentials (`scripts/zenith-check-image.py`), pulls
  and boots them with an empty Docker config, and uploads
  `zenith-image-update-<commit>` as an artifact: the updated manifest, a patch,
  and `image.json` with the old and new digests. A build that `main` has
  already moved past is marked `stale`.

## Releasing a new image to Zenith

1. Merge to `main`. CI publishes the images, as it always has.
2. Take the `zenith-update` artifact from that run and check `image.json`:
   `stale` must be `false`.
3. Open a pull request applying `zenith-compose.patch`. Its `zenith` check
   must pass.
4. Merge it, then submit the new version through Zenith.

Publishing an image changes nothing on Zenith, and neither does merging the
pin update: running deployments move only through Zenith's own review. Every
push to `main` rebuilds the images, so a pin-only merge produces new digests
too; there is no need to propose those.
