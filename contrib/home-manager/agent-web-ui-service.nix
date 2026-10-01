{ config, pkgs, ... }:

# Optional autostart for agent-web-ui as a systemd user service, managed
# declaratively by home-manager. Build the app first (`npm ci && npm run build`
# in appDir). Status:    systemctl --user status agent-web-ui
#            Logs:       journalctl --user -u agent-web-ui -n 20
#            Stop:       systemctl --user stop agent-web-ui
#            Uninstall:  remove this import and run home-manager switch.

let
  home = config.home.homeDirectory;
  appDir = "${home}/Desktop/git-stuff/webui";
in
{
  systemd.user.services.agent-web-ui = {
    Unit = {
      Description = "Agent Web UI for Pi and omp (127.0.0.1:4783)";
      After = [ "network.target" ];
    };
    Service = {
      ExecStart = "${pkgs.nodejs}/bin/node ${appDir}/dist/server/server/index.js";
      WorkingDirectory = appDir;
      Environment = [
        "PORT=4783"
        "WORKSPACE_ROOTS=${home}"
        # pi and omp live outside the Nix profile; omp also spawns git, rg, etc.
        "PATH=${home}/.local/bin:${home}/.node_modules/bin:/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin"
        # Other devices sign in with the login from `npm run set-password`
        # (the server refuses to start without one when either is set):
        # "HOST=0.0.0.0"                              # LAN; open the port in the firewall too
        # "ALLOWED_HOSTS=<machine>.<tailnet>.ts.net"  # Tailscale Serve
        # "ALLOWED_TAILSCALE_USERS=<your-tailscale-login>"  # optional extra check for Serve
      ];
      Restart = "on-failure";
      RestartSec = 5;
    };
    Install.WantedBy = [ "default.target" ];
  };
}
