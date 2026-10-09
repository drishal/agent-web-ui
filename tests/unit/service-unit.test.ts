import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations.
import { renderUnit } from "../../scripts/service.mjs";

const template = readFileSync(new URL("../../contrib/systemd/awui.service", import.meta.url), "utf8");

describe("systemd user unit", () => {
  it("runs this checkout's build with this node and the shell's PATH", () => {
    const unit: string = renderUnit(template, {
      appDir: "/home/me/agent web ui",
      node: "/usr/bin/node",
      pathEnv: "/home/me/agent web ui/node_modules/.bin:/home/me/.local/bin:/usr/bin:/usr/bin:/opt/100%/bin",
    });
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/me/agent web ui/dist/server/server/index.js"');
    expect(unit).toContain("WorkingDirectory=/home/me/agent web ui\n");
    expect(unit).toContain("ConditionPathExists=/home/me/agent web ui/dist/server/server/index.js");
    // npm run's own bin dirs go, duplicates go, and % is a literal, not a specifier.
    expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin:/opt/100%%/bin"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartPreventExitStatus=78");
    expect(unit).toContain("WantedBy=default.target");
  });
});
