# event-scout for the NixOS fleet.
#
# Deployed and verified on data-server: modules/containers/event-scout/default.nix
# in ~/.nixos-config, with "event-scout" added to hostContainers on the host.
#
# The images are built ON THE HOST AS ROOT. oci-containers runs podman as root
# and rootless podman keeps a separate image store, so an image built as your
# own user is invisible to the service and the unit fails with
# "image not known" -- which is exactly what happened the first time.
#
#   cd ~/src/event-scout
#   sudo podman build -t localhost/event-scout:latest -f Dockerfile .
#   sudo podman build -t localhost/event-scout-chromium:latest -f Dockerfile.chromium .
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

  # The two containers find each other by name, and oci-containers does not
  # create a network for them. Podman's DNS only answers on a user-defined
  # network — on the default one "event-scout-chromium" resolves to nothing,
  # and the app waits its full sixty seconds before giving up.
  network = "event-scout";

  # Built on the host as root, not pulled: the repository's CI cannot publish
  # to GHCR while the GitHub account is locked over an unpaid invoice. See the
  # rebuild commands at the top of this file. Worth moving to
  # ghcr.io/kapsikkum/event-scout once that is sorted — a locally built image
  # is not reproducible from the flake, which is the one thing wrong here.
  appImage = "localhost/event-scout:latest";
  chromiumImage = "localhost/event-scout-chromium:latest";

  # The database is small but it is the entire point of the app: every event
  # ever seen, what was shortlisted, and the density history. On the NAS mount
  # so it outlives the guest.
  stateDir = "/mnt/app-data/event-scout";
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
    ];
    requiredBy = [
      "podman-event-scout.service"
      "podman-event-scout-chromium.service"
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

  virtualisation.oci-containers.containers = {
    event-scout-chromium = {
      image = chromiumImage;
      # Built here. Left at the default, podman would try to fetch
      # "localhost/event-scout-chromium" from a registry and fail.
      pull = "never";
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

    event-scout = {
      image = appImage;
      pull = "never";
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
      };
    };
  };
}
