# The awui developer environment: node for the server/web tooling, bun for the
# binary build (`--compile`) and atui, plus the e2e browsers. Everything is the
# nixpkgs build (same glibc as this machine's runtime), which is what makes the
# compiled `awui` binary run — the upstream bun binary was built against a
# different glibc and segfaulted here.
{
  config,
  pkgs,
  ...
}: {
  packages = [
    pkgs.nodejs_22 # the server's runtime; tooling + atui's packages resolve against it
    pkgs.bun # bundler, atui, `bun build --compile`
    pkgs.esbuild # vite/rolldown's native side under nix
    pkgs.playwright-driver # the e2e browsers; PLAYWRIGHT_BROWSERS_PATH points here
  ];

  # The browsers Playwright drives come from nixpkgs, never `npx playwright install`.
  env.PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
  env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

  # Faster local runs.
  env.NPM_CONFIG_CACHE = "${config.devenv.root}/.npm-cache";

  tasks."awui:install" = {
    description = "npm install into the project";
    exec = "npm install";
    before = ["devenv:enterShell"];
  };

  tasks."awui:build" = {
    description = "Build dist/web and dist/server";
    exec = "npm run build";
  };

  tasks."awui:binary" = {
    description = "Compile the self-contained awui binary";
    exec = "bun run scripts/build-binary.ts";
    after = ["awui:build"];
  };

  processes.webui.exec = "npm run dev";
}
