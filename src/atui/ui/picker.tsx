// A search box over a list, centred over the screen: the Ctrl+K palette and
// the model and harness pickers. Matching is the web palette's (rankItems).
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { rankItems, type PaletteItem } from "../../web/palette.js";
import { clip } from "../format.js";
import { useTheme } from "./context.js";

const PAGE = 8;

/** `firstHeading`: name the first section too (the palette's "Actions" goes without saying; a project or "Hand off" does not). */
export function Picker(p: { title: string; placeholder: string; items: PaletteItem[]; onClose: () => void; firstHeading?: boolean }) {
  const t = useTheme();
  const size = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const shown = createMemo(() => rankItems(p.items, query()));
  createEffect(
    on(shown, (list) => {
      const first = list.findIndex((i) => !i.disabled);
      setActive(first < 0 ? 0 : first);
    }),
  );
  const width = () => Math.min(72, size().width - 4);
  const height = () => Math.min(22, size().height - 4);
  const visible = () => height() - 4;
  const offset = () => Math.max(0, Math.min(active() - Math.floor(visible() / 2), shown().length - visible()));

  const move = (step: number) => {
    const list = shown();
    if (list.length === 0) return;
    let i = active();
    for (let n = 0; n < Math.abs(step); n++) {
      let next = i;
      do next += Math.sign(step);
      while (next >= 0 && next < list.length && list[next]?.disabled);
      if (next < 0 || next >= list.length) break;
      i = next;
    }
    setActive(i);
  };

  const run = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    p.onClose();
    item.run();
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    const step = ({ down: 1, up: -1, pagedown: PAGE, pageup: -PAGE } as Record<string, number>)[key.name];
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      p.onClose();
    } else if (step !== undefined) {
      key.preventDefault();
      move(step);
    } else if (key.name === "return") {
      key.preventDefault();
      run(shown()[active()]);
    }
  });

  return (
    <box
      position="absolute"
      top={2}
      left={Math.max(0, Math.floor((size().width - width()) / 2))}
      width={width()}
      height={height()}
      zIndex={20}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t().accent}
      backgroundColor={t().surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={t().muted}>
        <b>{p.title}</b>
        <span style={{ fg: t().muted }}>{"   ↑↓ Enter · Esc"}</span>
      </text>
      <input focused placeholder={p.placeholder} textColor={t().text} backgroundColor={t().surface} focusedBackgroundColor={t().surface} onInput={(value: string) => setQuery(value)} />
      <box flexDirection="column" flexGrow={1} marginTop={1}>
        <For each={shown().slice(offset(), offset() + visible())}>
          {(item, i) => {
            const at = () => i() + offset();
            const head = () => at() === 0 || shown()[at() - 1]?.section !== item.section;
            return (
              <box flexDirection="column">
                <Show when={head() && (i() > 0 || p.firstHeading)}>
                  <text fg={t().muted}>{item.section}</text>
                </Show>
                <box flexDirection="row" backgroundColor={at() === active() ? t().selection : undefined} onMouseDown={() => run(item)}>
                  <text flexGrow={1} fg={item.disabled ? t().muted : at() === active() ? t().text : t().text2} wrapMode="none" truncate>
                    {`${item.current ? "✓ " : "  "}${clip(item.label, width() - 20)}`}
                  </text>
                  <Show when={item.hint}>
                    <text flexShrink={0} fg={t().muted}>{` ${clip(item.hint ?? "", 18)}`}</text>
                  </Show>
                </box>
              </box>
            );
          }}
        </For>
        <Show when={shown().length === 0}>
          <text fg={t().muted}>{`Nothing matches “${query().trim()}”`}</text>
        </Show>
      </box>
    </box>
  );
}
