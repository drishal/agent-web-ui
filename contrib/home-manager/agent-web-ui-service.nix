{ config, lib, pkgs, ... }:

# Optional autostart for agent-web-ui as a systemd user service, managed
# declaratively by home-manager. Build the app first (`npm ci && npm run build`
# in appDir); after pulling, rebuild and restart the unit.
#            Status:     systemctl --user status agent-web-ui
#            Logs:       journalctl --user -u agent-web-ui -n 20
#            Restart:    systemctl --user restart agent-web-ui
#            Uninstall:  remove this import and run home-manager switch.

let
  appDir = "%h/Desktop/git-stuff/webui";
in
{
  systemd.user.services.agent-web-ui = {
    Unit = {
      Description = "Agent Web UI for Pi and omp (127.0.0.1:4783)";
      # No build yet (or no checkout on this machine): skip instead of restart-looping.
      ConditionPathExists = "${appDir}/dist/server/server/index.js";
    };
    Service = {
      ExecStart = "${lib.getExe pkgs.nodejs} ${appDir}/dist/server/server/index.js";
      WorkingDirectory = appDir;
      Environment = [
        "PORT=4783"
        "WORKSPACE_ROOTS=%h"
        # The shell's toolset: pi and omp live outside the Nix profile, and the
        # agents' own tools (git, rg, sudo, cargo, ...) need the rest.
        "PATH=%h/.local/bin:%h/.node_modules/bin:%h/.cargo/bin:%h/.bun/bin:/run/wrappers/bin:${config.home.profileDirectory}/bin:/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin"
        # Other devices sign in with the login from `npm run set-password`
        # (the server refuses to start without one when either is set):
        # "HOST=0.0.0.0"                              # LAN; open the port in the firewall too
        # "ALLOWED_HOSTS=<machine>.<tailnet>.ts.net"  # Tailscale Serve
        # "ALLOWED_TAILSCALE_USERS=<your-tailscale-login>"  # optional extra check for Serve
      ];
      # SIGTERM is a clean exit (0), so "on-failure" would leave it dead after a stray kill.
      Restart = "always";
      RestartSec = 5;
    };
    Install.WantedBy = [ "default.target" ];
  };
}
