import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAdapter, gatewayOwner, gatewayRecord, processStartTime, scriptPython } from "../../src/server/harness/hermes.js";
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
  const saved = { PATH: process.env.PATH, HERMES_PYTHON: process.env.HERMES_PYTHON, HERMES_HOME: process.env.HERMES_HOME };
  afterEach(() => {
    process.env.PATH = saved.PATH;
    for (const key of ["HERMES_PYTHON", "HERMES_HOME"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A launcher on PATH whose Python answers --version and imports tui_gateway, and a home of its own to serve. */
  const install = () => {
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
    // Never the developer's own ~/.hermes: a gateway running there would be found.
    process.env.HERMES_HOME = tempDir("awui-hermes-home-");
    return python;
  };

  it("uses the launcher's own Python, and warns only when that cannot import the gateway", async () => {
    const python = install();
    const found = await new HermesAdapter().discover();
    expect(found.available).toBe(true);
    expect(found.warnings).toEqual([]);
    expect((await new HermesAdapter().spawnSpec()).command).toBe(python);

    process.env.HERMES_PYTHON = "/bin/false";
    const wrong = await new HermesAdapter().discover();
    expect(wrong.warnings).toEqual(["/bin/false from HERMES_PYTHON cannot import Hermes's tui_gateway; set HERMES_PYTHON to the Python of the Hermes install"]);
  });

  it("reports an owned home that answers nothing as unavailable, not as a missing CLI", async () => {
    install();
    // The record a running `hermes gateway` leaves in the home it owns, with no control
    // socket behind it (still starting, or wedged): a child of ours would be refused.
    writeFileSync(path.join(process.env.HERMES_HOME ?? "", "gateway.pid"), JSON.stringify({ pid: process.pid, kind: "hermes-gateway", start_time: await processStartTime(process.pid) }));
    const busy = await new HermesAdapter().discover();
    expect(busy.available).toBe(false);
    expect(busy.reason).toBe(`a Hermes gateway (pid ${process.pid}) owns the Hermes home but is not answering on its control socket yet`);
  });
});

describe("discovering Hermes installed by upstream's installer", () => {
  const saved = { PATH: process.env.PATH, HERMES_PYTHON: process.env.HERMES_PYTHON, HERMES_HOME: process.env.HERMES_HOME };
  afterEach(() => {
    process.env.PATH = saved.PATH;
    for (const key of ["HERMES_PYTHON", "HERMES_HOME"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A launcher holding `script`, on a PATH of its own, with a home of its own to serve. */
  const launcher = (script: (python: string) => string) => {
    const bin = tempDir("awui-hermes-installer-");
    const python = path.join(bin, "python3");
    writeFileSync(python, "#!/bin/sh\n");
    chmodSync(python, 0o755);
    writeFileSync(path.join(bin, "hermes"), script(python));
    chmodSync(path.join(bin, "hermes"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    delete process.env.HERMES_PYTHON;
    // Never the developer's own ~/.hermes: a gateway running there would be found.
    process.env.HERMES_HOME = tempDir("awui-hermes-home-");
    // The runtime is cached per command name, so each install gets its own path.
    return { launcher: path.join(bin, "hermes"), python };
  };

  /** What `--print-runtime-command` prints for `python`, and the rest of the launcher. */
  const prints = (python: string, rest: string) =>
    `#!/bin/sh\ncase "$1" in\n  --print-runtime-command) printf '%s\\n' '${JSON.stringify([python, "-I", "-c", "bootstrap"])}'; exit 0;;\n  --version) echo "Hermes Agent v0.22.2"; exit 0;;\nesac\n${rest}`;

  it("starts the gateway from the launch command the installer's launcher prints", async () => {
    // The installer's script: `exec` carries an inline Python bootstrap, so the interpreter
    // is past `-c` and the script does not end in `exec` — neither shape names a Python.
    const { launcher: bin, python } = launcher((p) => prints(p, '\' \"$@\"\n'));
    const adapter = new HermesAdapter({ launcher: bin });
    const found = await adapter.discover();
    expect(found.available).toBe(true);
    expect(found.warnings).toEqual([]);
    expect(await adapter.spawnSpec()).toMatchObject({ command: python, args: ["-I", "-c", "bootstrap"] });
  });

  it("asks a shell launcher that exports no HERMES_PYTHON the same way", async () => {
    const { launcher: bin, python } = launcher((p) => prints(p, `exec ${p} -m tui_gateway.entry "$@"\n`));
    const adapter = new HermesAdapter({ launcher: bin });
    expect((await adapter.discover()).warnings).toEqual([]);
    expect(await adapter.spawnSpec()).toMatchObject({ command: python, args: ["-I", "-c", "bootstrap"] });
  });
});

describe("the gateway that owns a Hermes home", () => {
  it("reads a pid record and ignores anything else", () => {
    expect(gatewayRecord('{"pid": 12, "start_time": 34, "kind": "hermes-gateway"}')).toEqual({ pid: 12, startTime: 34 });
    expect(gatewayRecord('{"pid": 12}')).toEqual({ pid: 12, startTime: null });
    expect(gatewayRecord('{"kind": "hermes-gateway"}')).toBeNull();
    expect(gatewayRecord("\u007fELF")).toBeNull();
  });

  it("reports a live owner, and neither a gone pid nor a recycled one", async () => {
    const home = tempDir("awui-hermes-home-");
    const started = await processStartTime(process.pid);
    const record = (pid: number, startTime: number | null) =>
      writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid, kind: "hermes-gateway", ...(startTime === null ? {} : { start_time: startTime }) }));

    record(process.pid, started);
    expect(await gatewayOwner(home)).toBe(process.pid);

    record(2 ** 30, started);
    expect(await gatewayOwner(home)).toBeNull();

    // A recycled pid: the number is alive, but it is not the process the record names.
    if (started !== null) {
      record(process.pid, started + 1);
      expect(await gatewayOwner(home)).toBeNull();
    }
  });
});
