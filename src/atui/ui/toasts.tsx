// News from sessions in the background, in the top right corner for a few
// seconds: one finished, failed, or asks for you. A click opens it.
import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { clip } from "../format.js";
import { useAtui, useTheme } from "./context.js";

const WIDTH = 40;

export function Toasts() {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const tone = (kind: string) => (kind === "asking" ? t().warn : kind === "failed" ? t().danger : t().ok);
  const head = (kind: string) => (kind === "asking" ? "▲ Needs you" : kind === "failed" ? "✗ Failed" : "✓ Done");
  const open = (sessionId: string, id: number) => {
    app.dismissToast(id);
    const s = app.overview().sessions.find((x) => x.id === sessionId);
    if (s) void app.openSession(s);
  };
  return (
    <Show when={app.toasts().length > 0 && size().width >= WIDTH + 10}>
      <box position="absolute" top={1} left={size().width - WIDTH - 2} width={WIDTH} zIndex={30} flexDirection="column">
        <For each={app.toasts()}>
          {(toast) => (
            <box border borderStyle="rounded" borderColor={tone(toast.kind)} backgroundColor={t().surface} paddingLeft={1} paddingRight={1} marginBottom={1} onMouseDown={() => open(toast.sessionId, toast.id)}>
              <text wrapMode="none" truncate>
                <span style={{ fg: tone(toast.kind) }}>{head(toast.kind)}</span>
                <span style={{ fg: t().text2 }}>{`  ${clip(toast.title, WIDTH - 16)}`}</span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
