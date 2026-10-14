// The composer (OpenCode's prompt box, with the web UI's chips): Enter sends,
// Shift+Enter or Ctrl+J adds a line; while the agent works Enter steers. A
// "/" opens the command menu, with the best match's rest shown dim after the
// cursor; an "@" opens the project's files. C-v attaches an image from
// the clipboard, and image files dropped on the terminal (pasted as their
// paths) attach too: numbered thumbnails above the box, Backspace in an
// empty box takes the last one off. The line under it names the
// harness, model and thinking level, the context used (with its recent
// history as a sparkline), and whether the next message compacts first.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createHostClipboard, decodePasteBytes, type HostClipboardService, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/solid";
import { IMAGE_MIME_TYPES, MAX_IMAGES, type SlashCommand } from "../../shared/protocol.js";
import { APP_COMMANDS, matchCommands, mergeCommands } from "../../web/commands.js";
import { modelName } from "../../web/turns.js";
import { applyMention, ghostCompletion, mentionAt } from "../assist.js";
import { tokens } from "../format.js";
import { sparkline } from "../fx.js";
import { attachmentFrom, attachmentFromFile, byteSize, clipboardImageByTool, imagePathsFromPaste, type PendingImage } from "../images.js";
import { harnessGlyph } from "../neat.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

/** From this share of the context the composer offers to compact first, and from this one it starts on. */
export const COMPACT_OFFER = 50;
export const COMPACT_DEFAULT = 80;

/** The host clipboard (Wayland, X11, macOS), opened on the first C-v. */
let clipboard: HostClipboardService | null = null;

export function Composer(p: {
  focused: boolean;
  compactChoice: boolean | null;
  onCompactChoice: (on: boolean | null) => void;
  /** A click on the footer's harness, model, or thinking level opens its picker. */
  onPick: (picker: "harness" | "models" | "thinking") => void;
  /** What the status bar used to say, now in the footer: vim's mode, a waiting C-x, a passing hint. */
  status: { mode: "normal" | "insert" | null; leader: boolean; note: string | null };
  ref: (el: TextareaRenderable) => void;
}) {
  const app = useAtui();
  const t = useTheme();
  let area: TextareaRenderable | undefined;

  // Images waiting to go with the next message.
  const [images, setImages] = createSignal<PendingImage[]>([]);
  const warn = (text: string) => app.setBanner({ level: "warning", text });
  const addImages = (found: Array<PendingImage | string>) => {
    const ok = found.filter((f): f is PendingImage => typeof f !== "string");
    const why = found.find((f): f is string => typeof f === "string");
    if (why) warn(why);
    if (ok.length === 0) return;
    if (images().length + ok.length > MAX_IMAGES) warn(`At most ${MAX_IMAGES} images go with one message`);
    setImages((list) => [...list, ...ok].slice(0, MAX_IMAGES));
  };
  // A paste that is image files (a drop) or image bytes attaches them; anything else is text, as usual.
  usePaste((event) => {
    if (!p.focused) return;
    if (event.metadata?.kind === "binary" && event.metadata.mimeType?.startsWith("image/")) {
      event.preventDefault();
      addImages([attachmentFrom(event.bytes)]);
      return;
    }
    const files = imagePathsFromPaste(decodePasteBytes(event.bytes), app.workspace()?.path ?? process.cwd());
    if (!files) return;
    event.preventDefault();
    void Promise.all(files.map(attachmentFromFile)).then(addImages);
  });
  const pasteClipboardImage = async () => {
    clipboard ??= createHostClipboard();
    const read = await clipboard.read({ preferredTypes: [...IMAGE_MIME_TYPES] as [string, ...string[]] }).catch(() => null);
    if (read?.status === "read" && read.representation.mimeType.startsWith("image/")) return addImages([attachmentFrom(read.representation.bytes)]);
    // OpenTUI's reader is not in every build: wl-paste or xclip then.
    const byTool = read?.status === "empty" || read?.status === "read" ? "empty" : await clipboardImageByTool(process.env);
    if (byTool instanceof Uint8Array) addImages([attachmentFrom(byTool)]);
    else if (byTool === "empty") warn("No image on the clipboard (paste text with C-S-v)");
    else warn("Cannot read the clipboard: install wl-clipboard (Wayland) or xclip (X11)");
  };

  // The "/" menu: open while the first word is typed; ↑/↓ move, Tab completes, Esc closes.
  const [text, setText] = createSignal("");
  const [commands, setCommands] = createSignal<SlashCommand[] | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const slash = () => /^\/(\S*)$/.exec(text())?.[1];
  const menuOpen = () => p.focused && slash() !== undefined && !dismissed();
  const menu = createMemo(() => (menuOpen() ? matchCommands(commands() ?? APP_COMMANDS, slash() ?? "").slice(0, 8) : []));
  createEffect(on(() => app.chat()?.chatId, () => setCommands(null)));
  createEffect(
    on(menuOpen, (open) => {
      const c = app.chat();
      if (!open || commands() !== null) return;
      if (!c) return setCommands(mergeCommands([]));
      app.server
        .call<{ commands: SlashCommand[] }>(`/api/chats/${c.chatId}/commands`)
        .then((r) => setCommands(mergeCommands(r.commands)))
        .catch(() => setCommands(mergeCommands([])));
    }),
  );
  createEffect(
    on(slash, (q) => {
      setMenuIndex(0);
      if (q === undefined) setDismissed(false);
    }),
  );
  const complete = (c: SlashCommand) => {
    area?.setText(`/${c.name} `);
    area?.gotoLineTextEnd();
  };
  const ghost = () => (menu().length > 0 && !text().includes("\n") ? ghostCompletion(text(), menu()[menuIndex()]) : "");

  // The "@" menu: the project's files matching what follows the @, asked for as you type.
  const mention = () => (p.focused ? mentionAt(text()) : null);
  const [files, setFiles] = createSignal<string[]>([]);
  const [fileIndex, setFileIndex] = createSignal(0);
  const [filesDismissed, setFilesDismissed] = createSignal(false);
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => mention()?.query,
      (q) => {
        clearTimeout(fileTimer);
        setFileIndex(0);
        if (q === undefined) {
          setFiles([]);
          setFilesDismissed(false);
          return;
        }
        fileTimer = setTimeout(() => {
          void app.searchFiles(q).then((list) => {
            if (mention()?.query === q) setFiles(list.slice(0, 8));
          });
        }, 80);
      },
    ),
  );
  onCleanup(() => clearTimeout(fileTimer));
  const fileMenu = () => (mention() && !filesDismissed() ? files() : []);
  const pickFile = (file: string) => {
    area?.setText(applyMention(text(), file));
    area?.gotoBufferEnd();
  };

  useKeyboard((key) => {
    if (!p.focused || key.defaultPrevented) return;
    if (key.ctrl && !key.meta && key.name === "v") {
      key.preventDefault();
      void pasteClipboardImage();
    } else if (key.name === "backspace" && images().length > 0 && !(area?.plainText ?? "")) {
      key.preventDefault();
      setImages((list) => list.slice(0, -1));
    }
  });
  useKeyboard((key) => {
    if (fileMenu().length === 0 || key.defaultPrevented) return;
    const list = fileMenu();
    if (key.name === "escape") {
      key.preventDefault();
      setFilesDismissed(true);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setFileIndex((i) => (i + (key.name === "down" ? 1 : -1) + list.length) % list.length);
    } else if (key.name === "tab" || (key.name === "return" && !key.shift)) {
      key.preventDefault();
      const file = list[fileIndex()];
      if (file) pickFile(file);
    }
  });
  useKeyboard((key) => {
    if (!menuOpen() || key.defaultPrevented || menu().length === 0) return;
    if (key.name === "escape") {
      key.preventDefault();
      setDismissed(true);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setMenuIndex((i) => (i + (key.name === "down" ? 1 : -1) + menu().length) % menu().length);
    } else if (key.name === "tab") {
      key.preventDefault();
      const c = menu()[menuIndex()];
      if (c) complete(c);
    } else if (key.name === "return" && !key.shift) {
      const c = menu()[menuIndex()];
      // A command typed in full that takes nothing runs on Enter; otherwise Enter completes it.
      if (c && !(c.name === slash() && !c.hint)) {
        key.preventDefault();
        complete(c);
      }
    }
  });

  const percent = () => app.chat()?.context?.percent ?? null;
  const offer = createMemo(() => {
    const c = app.chat();
    return Boolean(c && c.capabilities.supportsCompact && c.context?.tokens != null && (percent() ?? 0) >= COMPACT_OFFER && !app.busy());
  });
  const compactFirst = () => offer() && (p.compactChoice ?? (percent() ?? 0) >= COMPACT_DEFAULT);

  const submit = async () => {
    const text = area?.plainText ?? "";
    const attached = images();
    if (!text.trim() && attached.length === 0) return;
    area?.clear();
    setImages([]);
    const ok = await app.send(text, { ...(compactFirst() ? { compactFirst: true } : {}), ...(attached.length > 0 ? { images: attached } : {}) });
    if (ok) p.onCompactChoice(null);
    else {
      if (area && !area.plainText) area.setText(text);
      if (images().length === 0) setImages(attached);
    }
  };

  const placeholder = () => {
    const c = app.chat();
    if (!c) return `Ask ${app.harness()?.displayName ?? "the agent"} to…`;
    if (c.status === "running") return c.capabilities.supportsSteer ? "Steer the agent (Enter) · Esc Esc stops" : "Queue a follow-up (Enter) · Esc Esc stops";
    return "Message the agent…";
  };

  const mixTone = () => ((percent() ?? 0) >= 80 ? t().warn : accentOf(t(), app.harness()?.accent));

  const model = () => {
    const c = app.chat();
    if (!c?.config.model) return null;
    return modelName(c.config.model, c.config.models);
  };

  return (
    <box flexDirection="column" flexShrink={0} marginLeft={2} marginRight={2}>
      <Show when={menu().length > 0}>
        <box flexDirection="column" border borderStyle="rounded" borderColor={t().border} backgroundColor={t().surface} paddingLeft={1} paddingRight={1}>
          <For each={menu()}>
            {(c, i) => (
              <box flexDirection="row" backgroundColor={i() === menuIndex() ? t().selection : undefined} onMouseDown={() => complete(c)}>
                <text flexShrink={0} fg={i() === menuIndex() ? t().text : t().text2}>
                  {`/${c.name}`}
                  <span style={{ fg: t().muted }}>{c.hint ? ` ${c.hint}` : ""}</span>
                </text>
                <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
                  {c.description ? `  ${c.description}` : ""}
                </text>
                <text flexShrink={0} fg={t().muted}>{` ${c.source}`}</text>
              </box>
            )}
          </For>
          <text fg={t().muted}>↑↓ move · Tab completes · Esc closes</text>
        </box>
      </Show>
      <Show when={images().length > 0}>
        <box flexDirection="row" flexWrap="wrap" paddingLeft={1}>
          <For each={images()}>
            {(image, i) => (
              <box flexDirection="column" marginRight={2}>
                <Show when={app.imageMode}>{(protocol) => <image source={image.bytes} fit="fit" protocol={protocol()} width={10} height={4} />}</Show>
                <box flexDirection="row">
                  <text fg={t().muted}>
                    <span style={{ fg: t().text2, bg: t().surface2 }}>{` ▣ #${i() + 1} `}</span>
                    {` ${image.mimeType.replace("image/", "")} ${byteSize(image.bytes.byteLength)} `}
                  </text>
                  <text fg={t().danger} onMouseDown={() => setImages((list) => list.filter((x) => x !== image))}>
                    ×
                  </text>
                </box>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={fileMenu().length > 0}>
        <box flexDirection="column" border borderStyle="rounded" borderColor={t().border} backgroundColor={t().surface} paddingLeft={1} paddingRight={1}>
          <For each={fileMenu()}>
            {(file, i) => {
              const cut = file.lastIndexOf("/") + 1;
              return (
                <box flexDirection="row" backgroundColor={i() === fileIndex() ? t().selection : undefined} onMouseDown={() => pickFile(file)}>
                  <text wrapMode="none" truncate fg={t().muted}>
                    {"@"}
                    {file.slice(0, cut)}
                    <span style={{ fg: i() === fileIndex() ? t().text : t().text2 }}>{file.slice(cut)}</span>
                  </text>
                </box>
              );
            }}
          </For>
          <text fg={t().muted}>↑↓ move · Tab or Enter inserts · Esc closes</text>
        </box>
      </Show>
      <box
        border
        borderStyle="rounded"
        borderColor={p.focused ? accentOf(t(), app.harness()?.accent) : t().border}
        backgroundColor={app.glass() ? undefined : t().surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={(el: TextareaRenderable) => {
            area = el;
            p.ref(el);
          }}
          focused={p.focused}
          placeholder={placeholder()}
          placeholderColor={t().muted}
          textColor={t().text}
          focusedTextColor={t().text}
          backgroundColor={app.glass() ? undefined : t().surface}
          focusedBackgroundColor={app.glass() ? undefined : t().surface}
          cursorColor={t().accent}
          wrapMode="word"
          minHeight={1}
          maxHeight={8}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onSubmit={() => void submit()}
          onContentChange={() => setText(area?.plainText ?? "")}
        />
        <Show when={ghost()}>
          {(rest) => (
            <box position="absolute" top={0} left={1 + text().length}>
              <text fg={t().muted}>{rest()}</text>
            </box>
          )}
        </Show>
      </box>
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" flexGrow={1} overflow="hidden">
          <Show when={p.status.mode}>
            {(mode) => (
              <text flexShrink={0} wrapMode="none" fg={mode() === "normal" ? t().accent : t().muted}>
                <b>{mode() === "normal" ? "-- NORMAL -- " : "-- INSERT -- "}</b>
              </text>
            )}
          </Show>
          <Show when={p.status.leader}>
            <text flexShrink={0} wrapMode="none" fg={t().accent}>
              <b>{"C-x- "}</b>
            </text>
          </Show>
          <Show when={app.conn() !== "connected" && app.conn() !== "idle"}>
            <text flexShrink={0} wrapMode="none" fg={t().warn}>
              {"◌ reconnecting  "}
            </text>
          </Show>
          <text flexShrink={0} wrapMode="none" fg={accentOf(t(), app.harness()?.accent)} onMouseDown={() => p.onPick("harness")}>
            {`${harnessGlyph(app.harness()?.id ?? "")} ${app.harness()?.displayName ?? "—"} ▾`}
          </text>
          <Show when={model()}>
            <text flexShrink={1} wrapMode="none" truncate fg={t().text2} onMouseDown={() => p.onPick("models")}>
              {`  ${model()} ▾`}
            </text>
          </Show>
          <Show when={app.chat()?.config.thinkingLevel}>
            <text flexShrink={0} wrapMode="none" fg={t().muted} onMouseDown={() => p.onPick("thinking")}>
              {`  ${app.chat()?.config.thinkingLevel} ▾`}
            </text>
          </Show>
          <Show when={p.status.note}>
            {(note) => (
              // A narrow footer cuts the hint before the model's name.
              <text flexShrink={100} wrapMode="none" truncate fg={t().warn}>
                {`  ${note()}`}
              </text>
            )}
          </Show>
        </box>
        <text flexShrink={0}>
          {"  "}
          <Show when={offer()}>
            <span style={{ fg: compactFirst() ? t().warn : t().muted }}>{`${compactFirst() ? "compact first" : "full history"} ${tokens(app.chat()?.context?.tokens ?? 0)} (C-x f)  `}</span>
          </Show>
          <Show when={app.contextHistory().length > 1}>
            <span style={{ fg: mixTone() }}>{`${sparkline(app.contextHistory(), 100)} `}</span>
          </Show>
          <Show when={percent() !== null}>
            <span style={{ fg: (percent() ?? 0) >= 80 ? t().warn : t().muted }}>{`ctx ${Math.round(percent() ?? 0)}%`}</span>
          </Show>
        </text>
      </box>
    </box>
  );
}
