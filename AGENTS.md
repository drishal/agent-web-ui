# AGENTS.md

Guidance for coding agents (Pi, omp, Hermes, Claude Code, Codex, OpenCode, …)
working in this repository. The README is the user-facing manual; this file is
how to change the code without breaking what the README promises. When the two
disagree, the code is the truth: fix whichever is stale.

## What this is

**awui** (agent web UI) is a local, private web UI for the **Pi**, **omp**
(oh-my-pi), **Hermes** (hermes-agent), and **Claude Code** coding-agent
harnesses. **atui** is its terminal client. Both are thin clients of one Node
server:

```
browser (src/web, React)  ─┐
                            ├─ HTTP + SSE ─▶ server (src/server, Express 5) ─▶ HarnessAdapter ─▶ pi / omp / hermes / claude
atui    (src/atui, Solid) ─┘                 127.0.0.1:4783 by default             (one child process per live chat)
```

The harness is always the agent and the source of truth: its own models, auth,
settings, tools, trust decisions, and session files. awui only drives it,
renders it, and adds a few things on the side (checkpoints, pins, review
comments, notifications), each kept in awui's own state folder.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install. Never `npm -g`, never `npx playwright install` (see Environment). |
| `npm run dev` | Backend under `tsx watch` plus Vite on http://127.0.0.1:5173 (proxies `/api` to the backend's port). |
| `npm run build` | `vite build` → `dist/web`, then `tsc -p tsconfig.server.json` → `dist/server`. The server entry is `dist/server/server/index.js`. |
| `npm start` / `bin/awui` | Run the built server. |
| `bin/atui` (`npm run atui`) | Run the terminal client under Bun. Needs a running server. |
| `npm run typecheck` | Four projects: server, web, tests, atui. **Run it before every commit.** |
| `npm test` | Vitest: `tests/unit/**` (and `tests/smoke/**`, which skips itself unless `SMOKE=1`). |
| `npm run test:e2e` | Build, then Playwright (`tests/e2e`) against the built server with fake harnesses on port 4791. ~2.5 min. |
| `npm run test:atui` | Build, then `bun test tests/atui` (atui in OpenTUI's test renderer against a real server). |
| `npm run smoke` | Opt-in tests against the real installed harnesses. No model is called unless `SMOKE_MODEL` (and `SMOKE_CLAUDE_MODEL`) name one. |
| `npm run set-password` | Store an scrypt login for other devices. |
| `npm run service -- install\|uninstall\|print` | The systemd user unit (`contrib/systemd/awui.service`). |

A change is done when `npm run typecheck`, `npm test`, and the relevant one of
`npm run test:e2e` (web changes) or `npm run test:atui` (atui changes) pass.
Server changes that the browser sees need e2e too.

## Map of the code

```
src/shared/protocol.ts        Wire types and Zod request schemas: the only contract between server and clients.
src/shared/html-render.ts     Agent-rendered pages: bootstrap markup, theme payload, frame-height math (no harness types).
src/server/
  index.ts                    Startup: config, state-folder migration, registry, routes, listen, shutdown. Subcommand: `install tui`.
  app.ts                      Every route (Express 5), SSE, error mapping. All /api routes but health/login/logout need auth.
  embedded.ts                 The binary's baked-in assets: embedded web bundle, extension sources, version; materializes extensions into state dir for `-e`.
  install-tui.ts              `awui install tui`: fetch the atui source and drop a `~/.local/bin/atui` wrapper.
  assets.gen.ts               Checked-in stub replaced by the generated embed map at binary-build time.
  config.ts, user-config.ts   Environment + ~/.config/awui/config.yml → ServerConfig. settings.ts edits config.yml for the Settings dialog.
  security.ts, auth.ts        Host/Origin/Tailscale checks, local vs remote, scrypt logins, signed cookies, lockout.
  workspaces.ts               WORKSPACE_ROOTS confinement (realpath), folder browsing.
  chats/chat.ts               One live chat: the EventReducer folds HarnessEvents into ChatItems, the event log, SSE fan-out, commands.
  chats/manager.ts            Chat registry; one live writer per native session; idle reaping.
  harness/types.ts            HarnessAdapter / LiveChat contract and the normalized HarnessEvent union.
  harness/registry.ts         One factory per harness; AWUI_HARNESSES selects them.
  harness/{pi,omp,hermes,claude}.ts   The four adapters. fake.ts is the deterministic test adapter.
  harness/awui.ts              The Awui chat harness: a read-only `pi` child (subclass), own agent dir, write/exec tools denied. Web-only.
  awui-settings.ts             The Awui harness's provider settings: edit its isolated agent dir's models.json (keys never echoed).
  harness/agent-events.ts     Pi-family event and transcript normalization (Pi and omp share it); historyToItems.
  harness/session-files.ts    Pi/omp session JSONL: active branch by parentId, fork and seed writers.
  harness/claude-sessions.ts  Claude Code's session files.
  harness/tool-diff.ts        Every harness's edit result → one DiffLine[] shape.
  harness/subagents.ts        Delegation calls (omp task, pi-subagents, Claude Task) → SubagentRun[].
  harness/render-extension.ts The render_html extension's file and the -e args that load it (Pi/omp).
  harness/render-token.ts     render tool names; a result's details.htmlRender → HtmlRenderRef, spoof-guarded.
  html-render.ts              Agent-rendered pages under the state folder, addressed by id, one owner chat each.
  harness/handoff.ts          Cross-harness handoff: portable seed transcript and the briefing prompt.
  harness/deferred.ts         Resume-without-waiting: show the file's transcript while the harness starts.
  checkpoints.ts              Per-prompt work-tree snapshots in a shadow git repo; turn undo.
  git.ts, git-status.ts       Hardened git runner; the composer's git row.
  image-store.ts, notify.ts, limits.ts, session-marks.ts, run-command.ts, state-file.ts   Side features (see their header comments).
src/web/                      React 19 + Vite client. App.tsx is the shell; components/ the pieces; styles.css one stylesheet.
  api.ts, stream.ts           fetch wrapper (ApiError) and the reconnecting SSE stream.
  turns.ts                    Items → turns (prompt, process fold, answer); shared with atui.
src/atui/                     The terminal client (Bun + OpenTUI + Solid). state.ts is the app state; ui/ the components.
  format.ts, neat.ts, vim.ts  Pure formatting and key logic, unit-tested from tests/unit.
extensions/rewind-to.ts       A Pi/omp extension the server loads into its children (-e) for in-place Edit/Retry.
extensions/render-html.ts     A Pi/omp extension registering render_html, which publishes an HTML page into the chat.
extensions/eval-python.ts     An awui-harness extension registering eval_python: runs a snippet in a scratch tmp dir (no workspace).
contrib/                      systemd unit and home-manager modules (templates; users copy them).
tests/unit                    Vitest. tests/helpers/app.ts builds a real app with fake adapters (makeTestApp).
tests/fixtures                Scripted stand-ins: fake-omp.mjs, fake-hermes.mjs, fake-claude.mjs, themes/.
tests/e2e                     Playwright. global-setup.ts starts the built server with AWUI_HARNESSES=fake,fake-b.
tests/atui                    bun:test against a real server; helpers.tsx mounts atui in the test renderer.
design/                       App icon drafts. .todo/ is gitignored: private notes, never committed.
```

Every source file opens with a comment saying what it is for and why it is
shaped that way. Read it before changing the file.

## Rules that must hold

These are product promises (most are in the README). Breaking one is a bug even
if every test passes.

1. **Never edit an existing harness session file.** Forks, handoffs, and seeds
   only *add* new sessions in the harness's own store. In-place Edit/Retry goes
   through the harness itself (`/rewind-to` on Pi/omp, Hermes's own RPC), never
   by rewriting its JSONL. awui keeps no second transcript database.
2. **One live writer per session, in this process.** `ChatManager` maps a native
   session to one chat; a second tab or device attaches as another SSE
   subscriber. Never spawn a second child for a session that is already open.
3. **Normalize at the adapter boundary.** SDK and wire types never leave
   `src/server/harness/<name>.ts`; everything else sees `HarnessEvent`,
   `ChatItem`, and `protocol.ts` types. The browser never names a file path
   (transcripts, images, and checkpoints are looked up server-side by id).
4. **Declare capabilities honestly** (`supportsSteer`, `supportsFollowUp`,
   `supportsThinkingLevel`, `supportsCompact`, `supportsExtensions`,
   `supportsInteractiveRequests`, `supportsRename`, `supportsModelSelection`,
   `supportsFork`, `supportsHandoff`, `supportsRewind`). The UIs hide or disable
   what is not declared; gate server routes on them too.
5. **A run is finished only when the harness says it settled** (Pi's
   `agent_settled`, omp's `session_settled`, Hermes's and Claude's equivalents),
   not at a message end. Sends return once accepted; output streams.
6. **Bounded payloads.** Tool output is cut to head and tail (16 KB), args to
   4 KB, diffs to 800 lines / 40 KB, transcripts read as head and tail past 8 MB.
   Anything new that carries harness output gets a bound.
7. **Security model** (`security.ts`, README "Security"): local means loopback
   peer *and* loopback Host *and* no proxy headers. Every new route goes under
   `/api` behind `requireAuth`; validate bodies with a Zod schema from
   `protocol.ts` via `body(schema, req)`; throw `ChatError(status, code, message)`.
   Never read, return, or log harness credentials. No CDNs, no inline script or
   style (strict CSP). Raster images only (an SVG from this origin could run
   script). Git runs through `git.ts` (no `GIT_*` from the environment, no hooks,
   no fsmonitor, no gc); pass `--literal-pathspecs` when paths come from files.
8. **State lives in the state folder** (`$XDG_STATE_HOME/awui`, mode 0700),
   written through `state-file.ts` (`writeJson`: temp file + rename, mode 0600).
   User settings live in `~/.config/awui/` and are edited only through
   `settings.ts`, which checks a save the way startup checks the file.
9. **Runs outlive clients.** Closing a browser or quitting atui never stops a
   run; only an idle chat with no viewers is reaped (its session file stays).

## House style

- **TypeScript is strict** (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). Indexing returns `T | undefined`: handle it, or
  assert with `as` only where the index is provably in range.
- **No formatter is configured, and the code is not prettier-shaped.** Lines run
  long (up to ~180 columns) rather than wrap early. Do **not** run prettier or
  any formatter over a file: it rewrites every line and buries the change. Match
  the surrounding code by hand.
- **Comments say why, in plain sentences.** A file header explains the module;
  a comment above a non-obvious line explains the reason (a harness quirk, a
  security reason, a measured trade-off), not what the code literally does.
  Doc comments (`/** … */`) on exported functions and on protocol fields.
- **Names** read as English: `rememberImage`, `runsFromDetails`,
  `snapshotSoon`. Booleans and helpers are short and literal.
- **Small pure modules for logic, thin components for drawing.** Wording,
  parsing, and key handling go in pure functions (`tool-diff.ts`,
  `subagents.ts`, `atui/neat.ts`, `atui/vim.ts`) with unit tests; components
  stay mostly layout.
- **No new runtime dependencies** without a strong reason. The server needs
  only express, helmet, yaml, and zod; the clients add React, react-markdown,
  and remark-gfm (web) and OpenTUI with Solid (atui). Prefer `node:` built-ins.
- **Web UI:** colours are CSS custom properties on `:root`; a base16 theme
  overrides the base tokens and everything else derives from them with
  `color-mix`, so never hard-code a colour. Motion is short and eased out, and
  `prefers-reduced-motion` turns all of it off (a rule at the top of
  `styles.css`). Browser storage goes through `storage.ts` (`awui.` prefix);
  requests through `api.ts`. Every interactive element works by keyboard and
  has an accessible name: the e2e tests select by role and name.
- **atui:** the theme comes from the server's tokens (`theme.ts`); mouse and
  keyboard both work; new keys go into the palette and the help strings.

## Testing

- **Fake harnesses are the main tool.** `FakeAdapter` (`src/server/harness/fake.ts`)
  answers deterministic scripts chosen by words in the prompt: `tool`, `big`,
  `ask`, `twice`, `quiz`, `described`, `edit`, `showcase` (one call of every tool
  kind), `subagents` (a parallel pi-subagents run with live progress and
  transcripts), `recall`, `todo`, `bloat`, `slow` (many small chunks, to act
  mid-run), `fail`. Add a word there when a feature needs a new scenario,
  rather than mocking deeper.
- **Scripted CLIs** (`tests/fixtures/fake-omp.mjs`, `fake-hermes.mjs`,
  `fake-claude.mjs`) speak each harness's real wire protocol. Adapter changes
  get a test against one of them; record new frames from the real CLI rather
  than inventing them.
- **Unit tests** build a real server with `makeTestApp()` (tests/helpers/app.ts)
  and drive it with supertest and SSE; they never touch the developer's config
  (`AWUI_CONFIG_DIR=""`, temp state folders).
- **e2e** runs one worker against one server; tests share it, so a test must not
  depend on another's sessions, and long ones get their own project folder or
  chat. Select by role and accessible name, not CSS classes, where you can.
- **Real data checks.** When parsing a harness's files or events, check the
  parser against real sessions on the machine (`~/.pi/agent/sessions`,
  `~/.omp/agent/sessions`, `~/.claude/projects`) with a throwaway script, read
  only. Never open the session the current agent is itself running in.
- **Screenshots** for visual work: `AWUI_SCREENSHOTS=<dir> npx playwright test
  screenshots` writes frames; for atui, render frames in `tests/atui` and read
  them. Delete throwaway specs before committing.
- A flaky test is a bug to find (a race in the code or the test), not something
  to retry until green.

## Environment

- **Node ≥ 22.19 and npm; Bun ≥ 1.3.14 for atui.** On the maintainer's NixOS
  machine every tool comes from the system configuration (`~/dotfiles/NixOS`).
  Do not install anything globally or imperatively (`npm -g`, `pip install`,
  ad-hoc venvs). If something is missing, use it temporarily with
  `nix shell nixpkgs#<pkg>` and say what should be added to the dotfiles.
- **Playwright's browsers come from nixpkgs** through `PLAYWRIGHT_BROWSERS_PATH`,
  and `@playwright/test` is pinned to the matching `playwright-driver` version.
  Never run `npx playwright install`.
- **A real awui server may be running** on 127.0.0.1:4783 as a systemd user
  unit, with live chats in it. Tests use other ports (e2e 4791; unit tests pick
  free ones). Do not stop or restart it without checking for live chats
  (`GET /api/sessions`, entries with a `liveChatId`) and asking.
- **Long jobs** (the e2e suite, a real-harness probe) go in a named `tmux`
  session so a human can watch (`tmux attach -r -t <name>`), and are torn down
  when they finish: no tmux session, no leftover harness process, no busy port.
- When probing a real harness, use a scratch project folder and a scratch
  session directory where the harness allows one, and the cheapest model.

## Making common changes

**A new route.** Add the request schema to `protocol.ts`, the route to
`app.ts` under `/api` (after `requireAuth`), throw `ChatError` for failures, and
a supertest case in `tests/unit`. If a remote device must not be able to do it,
say why in the route's comment and test the 401/403.

**A new harness.** Implement `HarnessAdapter` and `LiveChat`
(`src/server/harness/types.ts`) in `src/server/harness/<name>.ts`, normalizing
into `HarnessEvent`; declare capabilities; add one line to `factories` in
`registry.ts`; write a scripted fake CLI in `tests/fixtures` and an adapter
test. `HarnessId` is a branded string, so the protocol types do not change. See
README "The adapter registry" and the ACP mapping there.

**A new tool rendering.** Tool calls arrive as `ToolItem` (category from
`toolCategory()` in agent-events.ts). Structured extras (a diff, subagent runs)
are worked out server-side from `tool_start` args and `tool_end` details and put
on the item; the web (`ToolBody.tsx`, `Conversation.tsx`) and atui
(`neat.ts`, `transcript.tsx`) only draw them. Handle the live path (chat.ts)
and history (`historyToItems`) both.

**A new setting.** Add it to `user-config.ts` (schema), `config.ts` (effective
value), `settings.ts` (read/write, and whether it needs a restart),
`SettingsDialog.tsx`, `config.example.yml`, and the README table.

**atui features.** State and server calls in `src/atui/state.ts`; keys in
`ui/app.tsx` (the palette, the Ctrl+X leader, `LEADER_HELP`, `KEYS_HELP`, and
vim's NORMAL mode in `vim.ts` all need to agree); pure logic in a module with a
unit test; a `tests/atui` case that drives it by keys or clicks.

## Commits and docs

- **Atomic commits, one topic each**: a feature, a fix, a refactor, a docs
  change. Stage per topic and check `git diff --cached` before committing. Each
  commit builds and passes on its own.
- **The subject states the new behaviour, in the present tense**, as the log
  does: "Checkpoint restore takes file names literally", "atui has a vim
  navigation mode". The body says what changed and why, wrapped at ~76
  columns.
- **Update the README in the same commit** as the behaviour it describes
  (features under "Using it", atui keys under "In a terminal", routes and
  limits under "Security", tests under "Testing").
- Never commit `.todo/`, `dist/`, `test-results/`, secrets, or exported session
  transcripts.
