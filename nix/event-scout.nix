# event-scout for the NixOS fleet.
#
# Lives in the fleet config as modules/containers/event-scout/default.nix, with
# "event-scout" in data-server's hostContainers, and is deployed with the rest
# of the fleet from the machine that holds it — data-server is not built on
# itself. In particular, ~/.nixos-config on data-server is a checkout from 2024
# that nothing uses any more: rebuilding from it would roll the whole host back
# two years. Do not.
#
# All three images come from GHCR, published by CI on every push to main, so
# deploying a code change is:
#
#   git push                                            # CI builds and publishes
#   sudo systemctl restart podman-event-scout           # pulls it, pull = "newer"
#   sudo systemctl restart podman-event-scout-crawler   # likewise, if it changed
#
# A change to this file is a fleet deploy rather than a restart.
#
# They used to be built on the host as root, because CI could not publish while
# the GitHub account was locked. That worked, but it rebuilt Chromium's image on
# the data server for changes CI had already built, and what ran was whatever
# someone last compiled there rather than anything this repository could name.
#
{
  config,
  lib,
  mkDomain,
  pkgs,
  ...
}:
let
  domain = mkDomain "events";
  port = 3001;

  # The containers find each other by name, and oci-containers does not create
  # a network for them. Podman's DNS only answers on a user-defined network — on
  # the default one "event-scout-chromium" resolves to nothing, and the app
  # waits its full sixty seconds before giving up.
  network = "event-scout";

  # Tagged :latest rather than by digest, which is the one thing the move to
  # the registry does not fix: a restart takes whatever main points at now, so
  # the flake still does not pin what actually runs. CI publishes a :<sha> tag
  # alongside; pin that if it ever matters more than being able to redeploy
  # without editing this file.
  appImage = "ghcr.io/kapsikkum/event-scout:latest";
  chromiumImage = "ghcr.io/kapsikkum/event-scout-chromium:latest";
  crawlerImage = "ghcr.io/kapsikkum/event-scout-crawler:latest";

  # The Ollama the two model-reading tasks talk to. Neither is on by default,
  # and both degrade to "cannot reach" rather than failing anything else, so
  # naming a host that is down costs nothing.
  #
  # By name rather than by address: podman's DNS forwards what it cannot answer
  # to the host's resolvers, so this resolves wherever the host can resolve it,
  # and survives squareeyes moving.
  ollamaUrl = "http://squareeyes:11434";

  # Local disk, matching the other containers on this fleet, and emphatically
  # not the NAS mount this first pointed at.
  #
  # SQLite over NFS is a bad idea twice over. POSIX advisory locking across
  # NFS is unreliable, which is a corruption risk; and node:sqlite is
  # synchronous, so every query blocks the event loop for as long as the
  # filesystem takes to answer. On a hard mount with timeo=600 that is up to
  # sixty seconds, which is exactly how long nginx waited before giving up on
  # /api/status -- fifty-five times in one hour.
  #
  # The NAS is the right place for bulk media, not for a live database.
  stateDir = "/opt/event-scout";
in
{
  # Deliberately no deployment.gateway.directPorts. That option allowlists the
  # port to the WAF host so a service can be fronted publicly; this one stays
  # on the LAN. The vhost below plus a DNS rewrite pointing the name at this
  # host is the whole of it.
  deployment.reverseProxy.vhosts."${domain}" = { inherit port; };

  systemd.services.init-event-scout-network = {
    description = "Podman network for event-scout";
    after = [ "podman.service" ];
    before = [
      "podman-event-scout.service"
      "podman-event-scout-chromium.service"
      "podman-event-scout-crawler.service"
    ];
    requiredBy = [
      "podman-event-scout.service"
      "podman-event-scout-chromium.service"
      "podman-event-scout-crawler.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${pkgs.podman}/bin/podman network exists ${network} \
        || ${pkgs.podman}/bin/podman network create ${network}
    '';
  };

  # uid 1000 is the "node" user the app image runs as.
  systemd.tmpfiles.rules = [ "d ${stateDir} 0750 1000 1000 - -" ];

  # The database is small and it is the entire point of the app: every event
  # ever seen, what was shortlisted, and the density history. Local disk is
  # where it runs; a nightly copy is what puts it on the NAS.
  systemd.services.event-scout-backup = {
    description = "Copy the event-scout database to the NAS";
    startAt = "daily";
    path = [ pkgs.sqlite ];
    serviceConfig = {
      Type = "oneshot";
      # VACUUM INTO writes one consistent file with the WAL folded in, which
      # a plain copy of a live database would not be.
      ExecStart = pkgs.writeShellScript "event-scout-backup" ''
        set -euo pipefail
        dest=/mnt/app-data/event-scout
        mkdir -p "$dest"
        rm -f "$dest/event-scout.db.tmp"
        sqlite3 ${stateDir}/event-scout.db "VACUUM INTO '$dest/event-scout.db.tmp'"
        mv -f "$dest/event-scout.db.tmp" "$dest/event-scout.db"
      '';
    };
  };

  virtualisation.oci-containers.containers = {
    event-scout-chromium = {
      image = chromiumImage;
      pull = "newer";
      autoStart = true;
      extraOptions = [
        "--network=${network}"
        # Chromium exhausts the default 64 MB /dev/shm and takes the renderer
        # down with it on any page worth scraping.
        "--shm-size=512m"
        # Hard caps, because this host also runs immich, karakeep, mealie and
        # n8n, and a scraper must not be able to take them down. A leaked tab
        # per venue once put this container at 6.5 GB of an 8 GB machine with
        # ninety-nine chromium processes and the load average north of sixty.
        # The leak is fixed; the cap is what makes the next one survivable.
        "--memory=2g"
        "--memory-swap=2g"
        "--cpus=2"
        "--pids-limit=512"
      ];
      # Deliberately no ports. An open DevTools port is remote code execution
      # for anything that can reach it; the app container reaches it across
      # the podman network and nothing else needs to.
      volumes = [ "event-scout-chromium-profile:/profile" ];
    };

    # The crawler: a separate program that the app asks for what it has found.
    # No ports, for the same reason as Chromium — its API is unauthenticated,
    # and the app reaches it across the podman network. Not a dependency of the
    # app either: a crawler that is down is a source that says so, nothing more.
    event-scout-crawler = {
      image = crawlerImage;
      pull = "newer";
      autoStart = true;
      extraOptions = [
        "--network=${network}"
        # Small caps. It fetches and parses one page per site at a time, and
        # has no business anywhere near the memory immich needs.
        "--memory=512m"
        "--memory-swap=512m"
        "--cpus=1"
        "--pids-limit=128"
      ];
      # A named volume rather than local disk worth backing up: the database
      # is a frontier of URLs, rewritten constantly, and rebuilds itself from
      # the searches if lost.
      volumes = [ "event-scout-crawler-data:/app/data" ];
      environment = {
        CRAWLER_PORT = "3002";
        # A page that gives a time with no zone is read as local time, so this
        # has to be the zone the events are in.
        TZ = config.time.timeZone;
      };
    };

    event-scout = {
      image = appImage;
      # Pull when the registry has something newer, so a restart is all a
      # deploy needs. "newer" rather than "always" because it falls back to the
      # copy already on disk when GHCR cannot be reached: an outage at GitHub
      # should not be able to stop this service coming back up.
      pull = "newer";
      autoStart = true;
      dependsOn = [ "event-scout-chromium" ];
      extraOptions = [ "--network=${network}" ];
      ports = [ "${toString port}:${toString port}" ];
      volumes = [ "${stateDir}:/app/data" ];
      environment = {
        # Set means "attach to that browser". Unset means "launch one
        # locally", which nothing in this image could do.
        BROWSER_CDP_URL = "http://event-scout-chromium:9222";
        API_PORT = toString port;
        # Decides when an event counts as past, and is also what the browser
        # tells the pages it visits: a container running UTC while claiming
        # en-AU is a contradiction a bot check can read.
        TZ = config.time.timeZone;
        # Only a default: the Settings page overrides it. Ollama listens on
        # 127.0.0.1 unless told otherwise, so squareeyes needs its own
        # services.ollama.host set to 0.0.0.0 for this to reach anything.
        OLLAMA_URL = ollamaUrl;
        # Where the crawler listens. Also only a default, overridden by the
        # Crawler URL in Settings.
        CRAWLER_URL = "http://event-scout-crawler:3002";
      };
    };
  };
}
