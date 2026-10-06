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
      Description = "Agent Web UI for Pi, omp, Hermes, and Claude Code";
      # No build yet (or no checkout on this machine): skip instead of restart-looping.
      ConditionPathExists = "${appDir}/dist/server/server/index.js";
    };
    Service = {
      ExecStart = "${lib.getExe pkgs.nodejs} ${appDir}/dist/server/server/index.js";
      WorkingDirectory = appDir;
      # Port, host and the login come from ~/.config/agentwebui/config.yml; anything set here
      # would override that file.
      Environment = [
        # The shell's toolset: pi and omp live outside the Nix profile, and the
        # agents' own tools (git, rg, sudo, cargo, ...) need the rest.
        "PATH=%h/.local/bin:%h/.node_modules/bin:%h/.cargo/bin:%h/.bun/bin:/run/wrappers/bin:${config.home.profileDirectory}/bin:/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin"
      ];
      # SIGTERM is a clean exit (0), so "on-failure" would leave it dead after a stray kill.
      Restart = "always";
      RestartSec = 5;
      # 78 = bad settings (e.g. HOST=0.0.0.0 without a login): stop and say why in the journal.
      RestartPreventExitStatus = 78;
    };
    Install.WantedBy = [ "default.target" ];
  };
}
