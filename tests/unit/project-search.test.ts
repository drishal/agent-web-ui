// Search in project (project-search.ts and its route): a fixed string across a
// project's files, through git or a bounded walk, with bounded results.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectSearch } from "../../src/shared/protocol.js";
import { cutLine, parseGrep } from "../../src/server/project-search.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const files = (root: string) => {
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "const port = 3000;\nlisten(Port);\n");
  writeFileSync(path.join(root, "README.md"), "Set the port with PORT.\n");
  writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "port\n");
  writeFileSync(path.join(root, "logo.bin"), Buffer.from([0, 1, 2, 112, 111, 114, 116]));
};

describe("search in project", () => {
  it("finds a fixed string in a git project's files, case-insensitively unless asked, and not in what git ignores", async () => {
    t = await makeTestApp();
    files(t.project);
    writeFileSync(path.join(t.project, ".gitignore"), "node_modules\n");
    execFileSync("git", ["init", "-q"], { cwd: t.project });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const found = (await agent.get(`/api/workspaces/${ws.id}/search?q=port`)).body as ProjectSearch;
    const at = found.matches.map((m) => `${m.path}:${m.line}`).sort();
    expect(at).toEqual(["README.md:1", "src/app.ts:1", "src/app.ts:2"]);
    expect(found.matches.find((m) => m.path === "src/app.ts" && m.line === 1)?.text).toBe("const port = 3000;");
    const exact = (await agent.get(`/api/workspaces/${ws.id}/search?q=Port&case=1`)).body as ProjectSearch;
    expect(exact.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/app.ts:2"]);
    // A pattern is taken literally; too short a query is refused.
    expect(((await agent.get(`/api/workspaces/${ws.id}/search?q=${encodeURIComponent("p.rt")}`)).body as ProjectSearch).matches).toEqual([]);
    expect((await agent.get(`/api/workspaces/${ws.id}/search?q=p`)).status).toBe(400);
    expect((await agent.get(`/api/workspaces/nope/search?q=port`)).status).toBe(404);
  });

  it("scans the files of a folder that is not a repository, skipping dependencies and binaries", async () => {
    t = await makeTestApp();
    files(t.project);
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const found = (await agent.get(`/api/workspaces/${ws.id}/search?q=port`)).body as ProjectSearch;
    expect(found.matches.map((m) => `${m.path}:${m.line}`).sort()).toEqual(["README.md:1", "src/app.ts:1", "src/app.ts:2"]);
  });

  it("cuts long lines around the match and keeps a few matches per file", () => {
    const long = `${"a".repeat(500)}needle${"b".repeat(500)}`;
    const cut = cutLine(long, 500);
    expect(cut.length).toBeLessThan(260);
    expect(cut).toContain("needle");
    expect(cut.startsWith("…") && cut.endsWith("…")).toBe(true);
    const out = Array.from({ length: 30 }, (_, i) => `big.txt\0${i + 1}\0needle ${i}`).join("\n");
    const parsed = parseGrep(out, "needle", false);
    expect(parsed.matches).toHaveLength(20);
    expect(parsed.truncated).toBe(true);
  });
});
