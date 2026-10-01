// Workspace selection is confined to WORKSPACE_ROOTS using realpath and
// path.relative descendant checks, never string prefixes, so `..` and
// symlinks pointing outside a root are rejected.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowseResult, DirEntry, WorkspaceInfo } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { expandHome } from "./config.js";

const MAX_ENTRIES = 2000;

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export class Workspaces {
  private roots: string[] = [];
  private byId = new Map<string, WorkspaceInfo>();

  private constructor(private readonly home: string) {}

  static async create(configuredRoots: string[], home: string): Promise<{ workspaces: Workspaces; warnings: string[] }> {
    const ws = new Workspaces(home);
    const warnings: string[] = [];
    for (const root of configuredRoots) {
      try {
        const real = await fs.realpath(root);
        const stat = await fs.stat(real);
        if (!stat.isDirectory()) throw new Error("not a directory");
        if (!ws.roots.includes(real)) ws.roots.push(real);
      } catch (error) {
        warnings.push(`Ignoring workspace root ${root}: ${(error as Error).message}`);
      }
    }
    return { workspaces: ws, warnings };
  }

  get rootList(): string[] {
    return [...this.roots];
  }

  private allowed(real: string): boolean {
    return this.roots.some((root) => isWithin(root, real));
  }

  /** Resolve user input to a real directory inside a root, or throw 403/404. */
  async resolve(input: string): Promise<string> {
    if (input.includes("\0")) throw new ChatError(400, "bad_path", "Invalid path");
    const absolute = path.resolve(expandHome(input.trim(), this.home));
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw new ChatError(404, "missing_project", "That folder does not exist");
    }
    if (!this.allowed(real)) throw new ChatError(403, "outside_roots", "That folder is outside the allowed workspace roots");
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new ChatError(400, "not_directory", "That path is not a folder");
    return real;
  }

  async open(input: string): Promise<WorkspaceInfo> {
    const real = await this.resolve(input);
    const id = createHash("sha256").update(real).digest("base64url").slice(0, 22);
    const info: WorkspaceInfo = { id, path: real, name: path.basename(real) || real };
    this.byId.set(id, info);
    return info;
  }

  /** Look up an opened workspace and confirm it still exists. */
  async get(id: string): Promise<WorkspaceInfo> {
    const info = this.byId.get(id);
    if (!info) throw new ChatError(404, "unknown_workspace", "Open the workspace again");
    try {
      const stat = await fs.stat(info.path);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      throw new ChatError(404, "missing_project", "The project folder no longer exists");
    }
    return info;
  }

  async browse(input?: string): Promise<BrowseResult> {
    if (!input) {
      return {
        path: null,
        parent: null,
        entries: this.roots.map((root) => ({ name: root, path: root, hidden: false })),
      };
    }
    const real = await this.resolve(input);
    const dirents = await fs.readdir(real, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      const full = path.join(real, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full, hidden: d.name.startsWith(".") });
      } else if (d.isSymbolicLink()) {
        // Follow symlinks to directories only when they stay inside a root.
        try {
          const target = await fs.realpath(full);
          if ((await fs.stat(target)).isDirectory() && this.allowed(target)) {
            entries.push({ name: d.name, path: full, hidden: d.name.startsWith(".") });
          }
        } catch {
          // Dangling link: skip.
        }
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = path.dirname(real);
    const parent = parentPath !== real && this.allowed(parentPath) ? parentPath : null;
    return { path: real, parent, entries };
  }
}
