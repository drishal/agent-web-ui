// Saved prompts: text you send often, kept by this server for every device
// and for atui, in its own state file (written whole, mode 0600). Names are
// unique, ignoring case, since `#name` picks one in a composer. Bounded in
// count and length (protocol.ts).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_SAVED_PROMPT_CHARS, MAX_SAVED_PROMPTS, type SavedPrompt } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { isObj, readJson, writeJson } from "./state-file.js";

function clean(raw: unknown): SavedPrompt | null {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.text !== "string") return null;
  const name = raw.name.trim().slice(0, 80);
  if (!raw.id || !name || !raw.text) return null;
  return { id: raw.id.slice(0, 64), name, text: raw.text.slice(0, MAX_SAVED_PROMPT_CHARS), updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
}

export class SavedPrompts {
  private prompts: SavedPrompt[] = [];

  private constructor(private readonly file: string | null) {}

  static inMemory(): SavedPrompts {
    return new SavedPrompts(null);
  }

  static async open(stateDir: string): Promise<SavedPrompts> {
    const store = new SavedPrompts(path.join(stateDir, "saved-prompts.json"));
    const raw = await readJson(store.file);
    const list = isObj(raw) && Array.isArray(raw.prompts) ? raw.prompts : [];
    const seen = new Set<string>();
    for (const item of list) {
      const p = clean(item);
      if (!p || seen.has(p.name.toLowerCase())) continue;
      seen.add(p.name.toLowerCase());
      store.prompts.push(p);
      if (store.prompts.length >= MAX_SAVED_PROMPTS) break;
    }
    return store;
  }

  /** By name. */
  list(): SavedPrompt[] {
    return [...this.prompts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  /** A new prompt, or `id`'s new name and text. A name another prompt has is refused (409). */
  async save(input: { id?: string; name: string; text: string }, now = Date.now()): Promise<SavedPrompt> {
    const name = input.name.trim();
    const clash = this.prompts.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== input.id);
    if (clash) throw new ChatError(409, "name_taken", `A saved prompt is already called “${clash.name}”`);
    const at = input.id ? this.prompts.findIndex((p) => p.id === input.id) : -1;
    if (input.id && at < 0) throw new ChatError(404, "prompt_not_found", "That saved prompt no longer exists");
    if (at < 0 && this.prompts.length >= MAX_SAVED_PROMPTS) throw new ChatError(422, "too_many_prompts", `At most ${MAX_SAVED_PROMPTS} prompts can be saved`);
    const prompt: SavedPrompt = { id: at >= 0 ? (this.prompts[at] as SavedPrompt).id : randomUUID(), name, text: input.text, updatedAt: now };
    if (at >= 0) this.prompts[at] = prompt;
    else this.prompts.push(prompt);
    await this.persist();
    return prompt;
  }

  async remove(id: string): Promise<void> {
    const before = this.prompts.length;
    this.prompts = this.prompts.filter((p) => p.id !== id);
    if (this.prompts.length === before) throw new ChatError(404, "prompt_not_found", "That saved prompt no longer exists");
    await this.persist();
  }

  private persist(): Promise<void> {
    return writeJson(this.file, { prompts: this.prompts });
  }
}
