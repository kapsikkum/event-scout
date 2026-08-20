# event-scout for the NixOS fleet.
#
# Drop this at modules/containers/event-scout/default.nix in ~/.nixos-config
# and add "event-scout" to hostContainers on the host that should run it.
#
# UNTESTED ON A HOST. Written from the shape of modules/containers/
# immich-public-proxy, but never evaluated — squareeyes went off the network
# before it could be. Expect to fix at least the storage path and the domain.
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

  # The two containers need to find each other by name, and oci-containers
  # does not create a network for them. Podman's DNS only answers on a
  # user-defined network, so on the default one "chromium" resolves to
  # nothing and the app waits sixty seconds and gives up.
  network = "event-scout";

  # Published by the repository's CI. Pinning by digest would be better than a
  # tag and is worth doing once the images actually exist — see the note about
  # GitHub Actions in the README.
  appImage = "ghcr.io/kapsikkum/event-scout:latest";
  chromiumImage = "ghcr.io/kapsikkum/event-scout-chromium:latest";

  # The database is small but it is the whole point of the app: every event
  # ever seen, what was starred, and the density history. On the NAS mount
  # rather than the guest's own disk so it survives the host being rebuilt.
  stateDir = "/mnt/app-data/event-scout";
in
{
  deployment.gateway.directPorts = [ port ];
  deployment.reverseProxy.vhosts."${domain}" = { inherit port; };

  systemd.services.init-event-scout-network = {
    description = "Podman network for event-scout";
    after = [ "podman.service" ];
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

  systemd.tmpfiles.rules = [
    # The app image runs as the "node" user, uid 1000 in the Debian base.
    "d ${stateDir} 0750 1000 1000 - -"
  ];

  virtualisation.oci-containers.containers = {
    event-scout-chromium = {
      image = chromiumImage;
      autoStart = true;
      extraOptions = [
        "--network=${network}"
        # Chromium exhausts the default 64 MB /dev/shm and takes the renderer
        # down with it on any page worth scraping.
        "--shm-size=512m"
      ];
      # Deliberately no ports. An open CDP port is remote code execution for
      # anything that can reach it; the app container reaches it over the
      # podman network and nothing else needs to.
      volumes = [ "event-scout-chromium-profile:/profile" ];
    };

    event-scout = {
      image = appImage;
      autoStart = true;
      dependsOn = [ "event-scout-chromium" ];
      extraOptions = [ "--network=${network}" ];
      ports = [ "${toString port}:${toString port}" ];
      volumes = [ "${stateDir}:/app/data" ];
      environment = {
        # Set means "attach to that browser"; unset means "launch one
        # locally", which nothing in this image could do.
        BROWSER_CDP_URL = "http://event-scout-chromium:9222";
        API_PORT = toString port;
        # Decides when an event counts as past, and is also what the browser
        # reports to the pages it visits — a container running UTC while
        # claiming en-AU is a contradiction a bot check can read.
        TZ = config.time.timeZone;
      };
    };
  };
}
