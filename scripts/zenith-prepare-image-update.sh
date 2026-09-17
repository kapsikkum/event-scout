#!/usr/bin/env bash
# After main's images are published: verify them as Zenith would pull them,
# boot them, and prepare zenith-compose.yml pinned to them, as a patch for
# someone to review and open a pull request with. Changes nothing itself.
#
#   SOURCE_SHA=<commit> OWNER=<ghcr owner> RUN_URL=<link> bash scripts/zenith-prepare-image-update.sh
#
# Writes zenith-image-update/: image.json, zenith-compose.yml and
# zenith-compose.patch (the last two only when a pin moved).
set -euo pipefail

: "${SOURCE_SHA:?}" "${OWNER:?}"
out="zenith-image-update"
mkdir -p "$out"

# Which image each service runs. Only these three are touched.
services=(app crawler chromium)
declare -A image_of=(
  [app]=event-scout
  [crawler]=event-scout-crawler
  [chromium]=event-scout-chromium
)

cp zenith-compose.yml "$out/zenith-compose.yml"
json_images=""
for service in "${services[@]}"; do
  name="ghcr.io/${OWNER}/${image_of[$service]}"
  tag="${name}:sha-${SOURCE_SHA}"

  # Without credentials, as Zenith pulls, and with retries: a push can take a
  # little while to be readable from the registry's front door.
  result=""
  for attempt in 1 2 3 4 5 6; do
    if result="$(python3 scripts/zenith-check-image.py "$tag")"; then break; fi
    result=""
    sleep $((attempt * 10))
  done
  if [ -z "$result" ]; then
    echo "could not verify $tag anonymously" >&2
    exit 1
  fi
  digest="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])')"
  new="${name}@${digest}"

  # Exactly one pin for this image, or the manifest is not what this expects.
  count="$(grep -cE "^    image: ${name}@sha256:[a-f0-9]{64}\$" "$out/zenith-compose.yml" || true)"
  if [ "$count" != "1" ]; then
    echo "expected one pinned ${name} in zenith-compose.yml, found ${count}" >&2
    exit 1
  fi
  old="$(grep -oE "${name}@sha256:[a-f0-9]{64}" "$out/zenith-compose.yml")"
  sed -i -E "s#^    image: ${name}@sha256:[a-f0-9]{64}\$#    image: ${new}#" "$out/zenith-compose.yml"
  json_images="${json_images}${json_images:+,}{\"service\":\"${service}\",\"old\":\"${old}\",\"new\":\"${new}\"}"
done

# A build that main has already moved past must not replace a newer proposal.
head="$(git ls-remote origin refs/heads/main | cut -f1)"
stale=false
if [ -n "$head" ] && [ "$head" != "$SOURCE_SHA" ]; then stale=true; fi

cat > "$out/image.json" <<JSON
{"source_sha":"${SOURCE_SHA}","main_head":"${head}","stale":${stale},"run_url":"${RUN_URL:-}","images":[${json_images}]}
JSON

if cmp -s zenith-compose.yml "$out/zenith-compose.yml"; then
  echo "zenith-compose.yml already pins these images; nothing to propose"
  rm "$out/zenith-compose.yml"
  exit 0
fi

docker compose -f "$out/zenith-compose.yml" config --quiet

# Pulled with an empty Docker config, so nothing cached or logged in helps.
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
docker compose -f "$out/zenith-compose.yml" pull --quiet
bash scripts/zenith-smoke.sh "$out/zenith-compose.yml"
rm -rf "$DOCKER_CONFIG"
unset DOCKER_CONFIG

diff -u zenith-compose.yml "$out/zenith-compose.yml" > "$out/zenith-compose.patch" || true
echo "prepared an update to the pins in $out (stale: ${stale})"
