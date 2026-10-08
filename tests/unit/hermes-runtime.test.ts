import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAdapter, scriptPython } from "../../src/server/harness/hermes.js";
import { tempDir } from "../helpers/app.js";

describe("the Python a hermes launcher runs with", () => {
  it("reads a console script's shebang, an env shebang, and pip's long-path line", () => {
    expect(scriptPython("#!/home/u/.hermes/hermes-agent/venv/bin/python\nimport sys\n")).toBe("/home/u/.hermes/hermes-agent/venv/bin/python");
    expect(scriptPython("#!/usr/bin/python3.12\n")).toBe("/usr/bin/python3.12");
    expect(scriptPython("#!/usr/bin/env python3\n")).toBe("python3");
    expect(scriptPython(`#!/bin/sh\n'''exec' "/very/long/venv/bin/python3" "$0" "$@"\n' '''\n`)).toBe("/very/long/venv/bin/python3");
    expect(scriptPython("#!/nix/store/x-bash/bin/bash\nexport HERMES_PYTHON=/p\nexec /x \"$@\"\n")).toBeNull();
    expect(scriptPython("\u007fELF")).toBeNull();
  });
});

describe("discovering Hermes installed as a console script (Ubuntu, pip, uv)", () => {
  const saved = { PATH: process.env.PATH, HERMES_PYTHON: process.env.HERMES_PYTHON };
  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.HERMES_PYTHON === undefined) delete process.env.HERMES_PYTHON;
    else process.env.HERMES_PYTHON = saved.HERMES_PYTHON;
  });

  it("uses the launcher's own Python, and warns only when that cannot import the gateway", async () => {
    const bin = tempDir("awui-hermes-bin-");
    // The install's Python: answers --version for the launcher, and imports tui_gateway.
    mkdirSync(path.join(bin, "venv", "bin"), { recursive: true });
    const python = path.join(bin, "venv", "bin", "python3");
    writeFileSync(python, '#!/bin/sh\ncase "$*" in *--version*) echo "Hermes Agent v1.2.3";; *"import tui_gateway.entry"*) exit 0;; esac\n');
    writeFileSync(path.join(bin, "hermes"), `#!${python}\nfrom hermes_cli.main import main\nmain()\n`);
    chmodSync(python, 0o755);
    chmodSync(path.join(bin, "hermes"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    delete process.env.HERMES_PYTHON;
    const found = await new HermesAdapter().discover();
    expect(found.available).toBe(true);
    expect(found.warnings).toEqual([]);
    expect((await new HermesAdapter().spawnSpec()).command).toBe(python);

    process.env.HERMES_PYTHON = "/bin/false";
    const wrong = await new HermesAdapter().discover();
    expect(wrong.warnings).toEqual(["/bin/false from HERMES_PYTHON cannot import Hermes's tui_gateway; set HERMES_PYTHON to the Python of the Hermes install"]);
  });
});
