// atui: Agent Web UI in the terminal, in OpenCode's TUI style (OpenTUI and
// Solid, run by Bun). A client of the same server as the browser, so every
// harness, session, approval, and setting is shared with the web UI.
import { createRoot } from "solid-js";
import { render } from "@opentui/solid";
import { Server } from "./client.js";
import { parseArgs, USAGE } from "./args.js";
import { readPrefs, writePrefs } from "./prefs.js";
import { createAtui, message } from "./state.js";
import { App } from "./ui/app.js";
import { startTicker, stopTicker } from "./ui/ticker.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`atui: ${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }
  const server = new Server(parsed.url);
  const app = createRoot(() => createAtui(server, parsed));
  try {
    await app.init();
  } catch (error) {
    console.error(`atui: ${message(error)}`);
    process.exit(1);
  }
  startTicker();
  let done = false;
  const exit = () => {
    if (done) return;
    done = true;
    const c = app.chat();
    app.dispose();
    stopTicker();
    renderer.destroy();
    if (c && c.items.some((i) => i.kind === "user")) {
      console.log(`The chat keeps running on the server: atui --chat ${c.chatId}, or ${parsed.url}/#chat=${c.chatId}`);
    }
    process.exit(0);
  };
  const renderer = await (async () => {
    const { createCliRenderer } = await import("@opentui/core");
    return createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 30 });
  })();
  // The command line, else $ATUI_VIM, else what Ctrl+X V last chose.
  const vim = parsed.vim ?? (process.env.ATUI_VIM ? process.env.ATUI_VIM === "1" : (readPrefs().vim ?? false));
  await render(() => <App app={app} onExit={exit} vim={vim} onVim={(on) => writePrefs({ vim: on })} />, renderer);
}

if (import.meta.main) void main();
