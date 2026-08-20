#!/bin/sh
# Chromium ignores --remote-debugging-address and binds the DevTools port to
# loopback regardless, which is deliberate on their part: an open CDP port is
# remote code execution, so it is not allowed off the machine by accident.
#
# It still has to be reachable from the app container. So Chromium keeps its
# port on loopback where it insists on being, and socat relays the published
# port to it. The two cannot share a number — binding 0.0.0.0:9222 would
# collide with 127.0.0.1:9222 — hence the split.
#
# This is not a hole in the above: the relay is reachable only on the compose
# network, which is exactly as far as the app container and no further. The
# port is never published to the host.
set -e

INTERNAL_PORT="${CHROMIUM_INTERNAL_PORT:-9221}"
PUBLIC_PORT="${CHROMIUM_PORT:-9222}"

# Clear the locks a previous container left in the profile.
#
# Chromium records the host and pid holding a profile and refuses to start if
# they look like someone else's -- "the profile appears to be in use by another
# Chromium process on another computer". A container gets a new hostname every
# start, so any profile that was not shut down cleanly reads as exactly that,
# and the service then fails its restart limit and takes the app down with it.
#
# Safe to remove unconditionally: this volume belongs to this container, and
# nothing else can be holding it at the moment the container is starting. It
# is the same cleanup the local launcher does in density/cdp.ts.
rm -rf /profile/Singleton* /profile/lockfile 2>/dev/null || true

socat "TCP-LISTEN:${PUBLIC_PORT},fork,reuseaddr,bind=0.0.0.0" \
      "TCP:127.0.0.1:${INTERNAL_PORT}" &

# exec, so Chromium becomes the process the container's life depends on. If it
# dies the container dies with it and the restart policy applies, rather than
# leaving a relay listening on a port with nothing behind it.
exec chromium \
  --headless=new \
  --remote-debugging-port="${INTERNAL_PORT}" \
  --user-data-dir=/profile \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --disable-features=Translate,AutomationControlled \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --mute-audio \
  --window-size=1280,900 \
  --use-gl=angle \
  --use-angle=swiftshader \
  about:blank
