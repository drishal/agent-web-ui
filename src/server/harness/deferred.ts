// A resumed chat that shows before its harness is up. The transcript comes
// from the session file (adapter.readTranscript, milliseconds) while the
// harness process starts behind it (0.4–3 s). Reads answer from the file
// until then; anything that needs the harness waits for it; once it is up,
// its events flow through, its config replaces the placeholder, and a
// "settled" moves the chat from Starting to Idle (which also re-reads
// context, usage, and todos).
import type {
  ChatConfig,
  ChatItem,
  ContextUsage,
  ImageAttachment,
  InteractionAnswer,
  SlashCommand,
  TodoItem,
} from "../../shared/protocol.js";
import { EventHub } from "./event-hub.js";
import type { HarnessEventListener, HarnessUsage, LiveChat } from "./types.js";

const NO_CONFIG: ChatConfig = { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };

export class DeferredLiveChat implements LiveChat {
  /** Chat.open reads this to start in "starting" rather than "idle". */
  readonly starting = true;
  private hub = new EventHub();
  private real: LiveChat | null = null;
  private disposed = false;
  /** A run (prompt, steer, follow-up) arrived before the harness did: its own events settle the chat. */
  private asked = false;
  private readonly ready: Promise<LiveChat>;

  constructor(
    private readonly id: string,
    private readonly transcript: { items: ChatItem[]; title: string | null },
    start: () => Promise<LiveChat>,
    describe: (error: unknown) => string,
  ) {
    this.ready = start().then(
      async (live) => {
        if (this.disposed) {
          await live.dispose().catch(() => undefined);
          throw new Error("This chat was closed");
        }
        this.real = live;
        live.subscribe((event) => this.hub.emit(event));
        const config = await live.getConfig().catch(() => null);
        if (config) this.hub.emit({ type: "config", config });
        if (!this.asked) this.hub.emit({ type: "settled" });
        return live;
      },
      (error: unknown) => {
        if (!this.disposed) this.hub.emit({ type: "fatal", message: describe(error) });
        throw error;
      },
    );
    this.ready.catch(() => undefined);
  }

  get nativeId(): string | null {
    return this.real?.nativeId ?? this.id;
  }

  get title(): string | null {
    return this.real?.title ?? this.transcript.title;
  }

  /** The harness, once it is up (a command waits here). `run` marks a prompt, which settles on its own. */
  private async harness(run = false): Promise<LiveChat> {
    if (run && !this.real) this.asked = true;
    return this.ready;
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    return this.real ? this.real.history() : this.transcript.items;
  }

  async getConfig(): Promise<ChatConfig> {
    return this.real ? this.real.getConfig() : NO_CONFIG;
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return this.real ? this.real.getContextUsage() : null;
  }

  async getUsage(): Promise<HarnessUsage | null> {
    return this.real ? this.real.getUsage() : null;
  }

  async getTodos(): Promise<TodoItem[]> {
    return this.real ? this.real.getTodos() : [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return (await this.harness()).listCommands();
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).prompt(text, images);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).steer(text, images);
  }

  async rewind(turn: number, text: string, images?: ImageAttachment[]): Promise<void> {
    const harness = await this.harness(true);
    if (!harness.rewind) throw new Error("This harness cannot replace a past message");
    return harness.rewind(turn, text, images);
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).followUp(text, images);
  }

  /** Nothing runs before the harness is up, so there is nothing to stop yet. */
  async abort(): Promise<void> {
    if (this.real) await this.real.abort();
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    return (await this.harness()).setConfig(patch);
  }

  async refreshModels(): Promise<void> {
    return (await this.harness()).refreshModels();
  }

  async rename(name: string): Promise<void> {
    return (await this.harness()).rename(name);
  }

  async compact(instructions?: string): Promise<void> {
    return (await this.harness()).compact(instructions);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    return this.real ? this.real.answer(requestId, answer) : false;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.hub.clear();
    // Still starting: the ready handler disposes the harness when it arrives.
    if (this.real) await this.real.dispose();
  }
}
