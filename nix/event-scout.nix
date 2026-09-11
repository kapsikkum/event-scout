# event-scout as a NixOS module: the app, a Chromium for the sources that need
# a real browser, and the crawler, as three podman containers on a network of
# their own.
#
#   imports = [ ./nix/event-scout.nix ];
#   services.event-scout.enable = true;
#
# Everything else has a default. The images come from GHCR, published by CI on
# every push to main, so deploying a code change is a restart — the containers
# pull when the registry has something newer:
#
#   sudo systemctl restart podman-event-scout podman-event-scout-crawler
#
# The app listens on localhost only unless `openFirewall` is set; put your own
# reverse proxy in front of it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.event-scout;
  inherit (lib) mkEnableOption mkIf mkMerge mkOption optionalAttrs optionals types;

  # The containers find each other by name, and oci-containers does not create
  # a network for them. Podman's DNS only answers on a user-defined network — on
  # the default one "event-scout-chromium" resolves to nothing, and the app
  # waits its full sixty seconds before giving up.
  network = "event-scout";

  image = name: "ghcr.io/kapsikkum/${name}:${cfg.imageTag}";

  # A page that gives a time with no zone is read as local time, and the zone
  # also decides when an event counts as past. Only set when the host has one.
  tz = optionalAttrs (config.time.timeZone != null) { TZ = config.time.timeZone; };

  units = [
    "podman-event-scout.service"
    "podman-event-scout-chromium.service"
  ] ++ optionals cfg.crawler.enable [ "podman-event-scout-crawler.service" ];
in
{
  options.services.event-scout = {
    enable = mkEnableOption "event-scout, a local events aggregator";

    port = mkOption {
      type = types.port;
      default = 3001;
      description = "Port the app listens on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Listen on every interface and open the port. Off by default: the app
        is meant to sit behind a reverse proxy, and binds to localhost.
      '';
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/event-scout";
      description = ''
        Where the database and the flyer copies live. Keep it on local disk:
        SQLite over NFS is unreliable locking and, since node:sqlite is
        synchronous, a hard mount that stalls stalls every request with it.
        Use `backup` to get a copy onto network storage.
      '';
    };

    imageTag = mkOption {
      type = types.str;
      default = "latest";
      example = "0.5.0";
      description = ''
        Image tag for all three containers. `latest` follows main; CI also
        publishes a tag per release and per commit, which pins what runs.
      '';
    };

    ollamaUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "http://ollama.example:11434";
      description = ''
        Default Ollama address for the model tasks. Only a default: the
        Settings page overrides it. Both tasks are off until switched on, and
        degrade to "cannot reach" rather than failing anything else.
      '';
    };

    crawler = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Run the crawler beside the app. The app treats it as one more source.";
      };
      social = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Let the crawler read Instagram and note Facebook events. Both sites'
          robots.txt ask crawlers to stay out; see the README before leaving
          this on.
        '';
      };
    };

    backup = {
      enable = mkEnableOption "a nightly copy of the database";
      directory = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/mnt/backup/event-scout";
        description = "Where the nightly copy goes.";
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = !cfg.backup.enable || cfg.backup.directory != null;
          message = "services.event-scout.backup.directory must be set when backup is enabled.";
        }
      ];

      networking.firewall.allowedTCPPorts = optionals cfg.openFirewall [ cfg.port ];

      # The units below are podman's, and the containers find each other by
      # podman's DNS. Defaults, so a host already running Docker can say so.
      virtualisation.podman.enable = lib.mkDefault true;
      virtualisation.oci-containers.backend = lib.mkDefault "podman";

      systemd.services.init-event-scout-network = {
        description = "Podman network for event-scout";
        after = [ "podman.service" ];
        before = units;
        requiredBy = units;
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
      systemd.tmpfiles.rules = [ "d ${cfg.stateDir} 0750 1000 1000 - -" ];

      virtualisation.oci-containers.containers = {
        event-scout-chromium = {
          image = image "event-scout-chromium";
          # Pull when the registry has something newer. "newer" rather than
          # "always" because it falls back to the copy on disk when the
          # registry cannot be reached, so an outage there cannot stop this
          # coming back up.
          pull = "newer";
          autoStart = true;
          extraOptions = [
            "--network=${network}"
            # Chromium exhausts the default 64 MB /dev/shm and takes the
            # renderer down with it on any page worth scraping.
            "--shm-size=512m"
            # Hard caps, so a scraper cannot take down whatever else shares
            # the host. A leaked tab per venue once grew this to 6.5 GB and a
            # hundred processes; the leak is fixed, and the cap is what makes
            # the next one survivable.
            "--memory=2g"
            "--memory-swap=2g"
            "--cpus=2"
            "--pids-limit=512"
          ];
          # Deliberately no ports. An open DevTools port is remote code
          # execution for anything that can reach it; the app reaches it
          # across the podman network and nothing else needs to.
          volumes = [ "event-scout-chromium-profile:/profile" ];
        };

        event-scout = {
          image = image "event-scout";
          pull = "newer";
          autoStart = true;
          dependsOn = [ "event-scout-chromium" ];
          extraOptions = [ "--network=${network}" ];
          ports = [ "${lib.optionalString (!cfg.openFirewall) "127.0.0.1:"}${toString cfg.port}:${toString cfg.port}" ];
          volumes = [ "${cfg.stateDir}:/app/data" ];
          environment =
            {
              # Set means "attach to that browser". Unset means "launch one
              # locally", which nothing in this image could do.
              BROWSER_CDP_URL = "http://event-scout-chromium:9222";
              API_PORT = toString cfg.port;
            }
            // tz
            // optionalAttrs (cfg.ollamaUrl != null) { OLLAMA_URL = cfg.ollamaUrl; }
            // optionalAttrs cfg.crawler.enable { CRAWLER_URL = "http://event-scout-crawler:3002"; };
        };
      };
    }

    (mkIf cfg.crawler.enable {
      # A separate program the app asks for what it has found. No ports, for
      # the same reason as Chromium: its API is unauthenticated, and the app
      # reaches it across the podman network. Not a dependency of the app: a
      # crawler that is down is a source that says so, nothing more.
      virtualisation.oci-containers.containers.event-scout-crawler = {
        image = image "event-scout-crawler";
        pull = "newer";
        autoStart = true;
        extraOptions = [
          "--network=${network}"
          # It fetches and parses one page per site at a time.
          "--memory=512m"
          "--memory-swap=512m"
          "--cpus=1"
          "--pids-limit=128"
        ];
        # A named volume rather than state worth backing up: the database is a
        # frontier of URLs, rewritten constantly, and rebuilds itself if lost.
        volumes = [ "event-scout-crawler-data:/app/data" ];
        environment = {
          CRAWLER_PORT = "3002";
          CRAWLER_SOCIAL = lib.boolToString cfg.crawler.social;
        } // tz;
      };
    })

    (mkIf cfg.backup.enable {
      # VACUUM INTO writes one consistent file with the WAL folded in, which a
      # plain copy of a live database would not be.
      systemd.services.event-scout-backup = {
        description = "Copy the event-scout database";
        startAt = "daily";
        path = [ pkgs.sqlite ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = pkgs.writeShellScript "event-scout-backup" ''
            set -euo pipefail
            dest=${lib.escapeShellArg cfg.backup.directory}
            mkdir -p "$dest"
            rm -f "$dest/event-scout.db.tmp"
            sqlite3 ${lib.escapeShellArg "${cfg.stateDir}/event-scout.db"} "VACUUM INTO '$dest/event-scout.db.tmp'"
            mv -f "$dest/event-scout.db.tmp" "$dest/event-scout.db"
          '';
        };
      };
    })
  ]);
}
