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
