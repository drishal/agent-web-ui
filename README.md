# agent-web-ui

A local, private, responsive web UI for the **Pi** and **omp** (oh-my-pi) coding-agent harnesses. Use it from your desktop browser or, through Tailscale Serve, from your phone.

The browser is only a control surface. Each harness remains the agent and the source of truth for its own models, authentication, settings, tools, resources, trust decisions, and session files. This app never edits session files and keeps no second transcript database.

```
browser ──HTTP/SSE──▶ Node server (127.0.0.1:4783) ──▶ HarnessAdapter
                                                        ├─ Pi   (in-process SDK, @earendil-works/pi-coding-agent 0.87.1)
                                                        ├─ omp  (child process: `omp --mode rpc-ui`, one per live chat)
                                                        └─ fake (tests only)
```

## Install and run

Requirements: Node ≥ 22.19 (24 LTS recommended), npm, and `pi` and/or `omp` installed and logged in. A missing harness shows as unavailable instead of crashing the app.

```bash
npm ci
npm run build
npm start            # serves UI + API on http://127.0.0.1:4783
```

Startup prints a **launch URL carrying a token**:

```
Local: http://127.0.0.1:4783/?token=…
```

Open it once; the browser trades the token for a cookie and the token disappears from the address bar. A browser without that cookie gets `401` from every API route.

| Script | What it does |
|---|---|
| `npm run dev` | Backend under `tsx watch` plus Vite on :5173, proxying `/api`. Prints a `Dev UI: http://127.0.0.1:5173/?token=…` link. |
| `npm run typecheck` | Strict TypeScript for server, web, and tests |
| `npm test` | Vitest unit and integration tests. Uses only fake and scripted harnesses, so no model tokens are spent. |
| `npm run test:e2e` | Builds, then runs Playwright (Chromium) against the fake harnesses |
| `npm run smoke` | Opt-in checks against the real installed Pi and omp (see [Testing](#testing)) |
| `npm run build` / `npm start` | Production build, then a single process serving UI and API |

### Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4783` | Validated, 1024–65535. The bind address is always literal `127.0.0.1` and is not configurable. |
| `WORKSPACE_ROOTS` | home dir | `:`-separated. Projects must be inside a root, checked by realpath, so symlink and `..` escapes are refused. |
| `ALLOWED_HOSTS` | — | Comma-separated extra `Host` values (e.g. your `*.ts.net` Serve name). |
| `ALLOWED_TAILSCALE_USERS` | — | Comma-separated Tailscale logins. **Required** for any non-loopback request. |
| `THEME_FILE` | `$XDG_CONFIG_HOME/agent-web-ui/theme.yaml` | base16/base24 scheme (see [Theme](#theme)) |
| `OMP_AGENT_DIR`, `OMP_SESSION_DIR` | — | Overrides for omp only (see [Config dirs](#config-dirs)) |
| `XDG_STATE_HOME` | `~/.local/state` | The cookie-signing secret lives in `agent-web-ui/cookie-secret` (mode 0600) |

## Using it

- **Sidebar.** New chat, the harness switcher, and the project come first. Below them sit session search and the sessions themselves: date headings when one harness is selected, harness groups with counts in the *All* view. A green dot means the session is already open in this server; clicking it attaches to that chat rather than opening a second writer. The footer holds the theme, the chat **text size** (scales the conversation and composer only, per device), and *Pair phone*.
- **Harness switcher.** Pi or omp. Switching changes which harness new and resumed chats use; open chats stay on the harness that created them.
- **Project.** Recent folders, a folder browser that walks `WORKSPACE_ROOTS` one level at a time, or a typed path.
- **New chat.** Opens as a centred composer.
- **Each turn** shows:
  - your prompt as a bubble that stays pinned while you scroll through a long turn;
  - one **"Worked for 12s · 3 reads, 1 edit"** line folding the agent's thinking, intermediate notes, tool calls, and approvals (open while running, collapsed after);
  - the answer as plain text with a Copy button;
  - a **Changed N files** list for edits and writes.
- **Inside the fold.** Each step is a single quiet line (`read · src/app.ts`); click it for the input/output panel. Red appears only for real failures.
- **Composer card.**
  - Model and thinking sit inside the card. Tools are never narrowed: every chat uses the harness's normal tool set, extension tools included.
  - The **context ring** shows how full the context window is.
  - While a run is active you get **Steer**, **Follow-up**, and **Stop**. A harness without steer offers only **Stop and send**, labelled exactly that.
  - Enter sends; on touch devices Enter adds a newline and you tap Send.
- **Status stack** above the composer: queued steering/follow-up messages, the harness's todos (omp), and extension status. Hide it with the ridge (remembered per chat).
- **Approvals and dialogs** take over the composer card. Several pending requests stack, the first answer wins, and Stop cancels them.
- **Turn rail** on the right (wide screens): one mark per turn; hover for the prompt, click to jump.
- **Status bar** at the bottom (desktop): connection, harness · model · thinking, project path, version. Phones show a banner only when the connection drops.
- **Chat menu (⋯):** Rename, Compact context, Close chat.

TUI-only slash commands are not emulated. New, Resume, Rename, Compact, model, thinking, and tools are the web actions.

## Architecture

```
src/shared/protocol.ts      wire types + Zod request schemas (no SDK types)
src/server/
  harness/types.ts          HarnessAdapter / LiveChat contract, normalized HarnessEvent
  harness/registry.ts       adapter registry (one entry per harness)
  harness/agent-events.ts   Pi-family event + transcript normalization (shared by pi/omp)
  harness/pi.ts             Pi adapter (SDK)
  harness/omp.ts            omp adapter (rpc-ui child process, ACP lister)
  harness/fake.ts           deterministic adapter for tests
  chats/chat.ts             one live chat: state fold, event log, SSE fan-out, commands
  chats/manager.ts          chat registry, one live writer per native session
  security.ts               Host/Origin/Tailscale checks, token→cookie auth
  workspaces.ts             roots, realpath confinement, folder browsing
  theme.ts                  base16/base24 parsing, contrast-checked CSS variables
  app.ts, index.ts          Express 5 routes, SSE, startup/shutdown
src/web/                    React + Vite client
```

**Single writer.** `chatId → live session` and `harnessId + native session id → chatId` mean the same session is never opened twice in this process. For omp that also means never two child processes. A second tab or device attaches to the existing chat as another SSE subscriber. **Another terminal or process running `pi`/`omp` is not locked out.** Avoid driving the same session from a terminal while it is open here.

**Run lifecycle.** A run is not marked complete at a message end or a bare `agent_end`. Pi's `agent_settled` and omp's `session_settled`/`prompt_result.sessionSettled` decide it. Sends return `202` once the harness accepts them; output streams over SSE.

**SSE.** `GET /api/chats/:id/events` sends a snapshot on connect, then monotonic event ids. It replays from `Last-Event-ID` or `?lastEventId=` when still in the 5000-event window, and resnapshots otherwise. A heartbeat goes out every 20 s, nothing is compressed, and token deltas are coalesced every 30 ms. Tool output is bounded (head and tail of 16 KB). The client reconnects with jittered backoff (0.5 s→10 s, then stays at the cap), pauses while offline, retries immediately on `online` or when the tab becomes visible, and treats 45 s without a heartbeat as dead.

### The adapter registry: adding a harness

A third harness is a new file plus a registry entry:

1. Implement `HarnessAdapter` and `LiveChat` from `src/server/harness/types.ts` in `src/server/harness/<name>.ts`. Normalize everything into `HarnessEvent`. Never pass SDK or wire types further out.
2. Declare `capabilities` honestly. The UI hides or disables whatever is not declared (steer, follow-up, thinking, compact, rename, model selection, interactive requests).
3. Add one line to `factories` in `src/server/harness/registry.ts`, and its name to `AWUI_HARNESSES` if it should not be on by default.
4. Run the contract tests against it. `tests/unit/api.test.ts` exercises the same chat flows the fake adapter supports.

`HarnessId` is a branded string, so adding one never edits the protocol types.

#### Later harnesses via ACP

The natural generic adapter is the [Agent Client Protocol](https://agentclientprotocol.com) (DeepSeek Harness `dsh --profile acp`, `omp acp`, and the Claude Code, Codex, and Gemini ACP bridges). The mapping onto this app's events:

| ACP | This app |
|---|---|
| `agent_message_chunk` | `assistant_delta` (text) |
| `agent_thought_chunk` | `assistant_delta` (thinking) |
| `tool_call` / `tool_call_update` | `tool_start` / `tool_update` / `tool_end` |
| `plan`, `usage_update` | notices |
| `session/request_permission` | `request` (InteractionRequest) |
| `session/load` replay | `history()` |
| `session/list` | `listSessions()` |
| `session/cancel` | `abort()` |
| session config options | model / thinking / mode |

ACP has no standard steer or follow-up, so an ACP adapter declares `supportsSteer: false` and `supportsFollowUp: false`. Pi and omp do **not** use ACP here. omp's ACP mode cancels a running turn when a new prompt arrives instead of steering, and Pi has only third-party bridges.

### Pi

Pi runs in-process through the pinned SDK (`createAgentSessionServices` → `createAgentSessionFromServices`). It loads Pi's normal global and project settings, AGENTS files, skills, prompt templates, extensions, and custom models through Pi's own loader. Extensions get a web `ExtensionUIContext`: `select`, `confirm`, `input`, and `editor` become dialog cards, `notify` becomes a notice, and status/widgets become chips. TUI-only calls (`custom`, footers, themes) are no-ops.

**Trust.** The SDK trusts project folders by default; the Pi CLI does not. This adapter mirrors the CLI and never prompts: it uses the stored decision in Pi's trust store, then your `defaultProjectTrust` setting, and otherwise does not trust the folder. A skipped folder shows a notice telling you to run `pi` there once.

Tools are Pi's normal active set (your `defaultTools` plus extension tools); this host never narrows them. Model and thinking changes use `persist: false`, so the web UI never rewrites your Pi defaults.

### omp

omp's npm package requires Bun and ships raw `.ts`, so it cannot be imported into this Node server. Each live chat therefore runs the **installed** `omp` in `--mode rpc-ui`, one child process per chat. `rpc-ui` is the mode with tool-approval and extension-UI requests over the protocol; plain `rpc` has no UI, so approvals would fail closed.

- **Listing:** omp's RPC has no session listing, so a short-lived `omp acp` process answers `session/list` and exits after 60 s idle.
- **Resume:** `--resume <id>` with `--cwd`. The adapter checks that omp opened exactly that session.
- **Tools:** omp starts with its normal tool set. The app never passes `--tools`.
- **Home directory:** omp refuses to work in your home directory itself (it would switch to a temp dir), so the UI disables omp for a workspace that is exactly `~`. It never passes `--allow-home`.
- **Lifecycle:** children are killed on dispose and on `SIGINT`/`SIGTERM`. A crash surfaces as a chat error. Protocol types are hand-written from omp **18.4.5**; other versions show a warning.

### Approvals and extension dialogs

Tool approvals come from omp's `tools.approvalMode` (`always-ask` | `write` | `yolo`, as configured; this app never changes it or passes `--auto-approve`). Dialogs come from Pi or omp extensions (`select`, `confirm`, `input`, `editor`). Both become one `interaction_request`:

- It takes over the composer and stays in the conversation as a card that records the outcome.
- Pending requests are part of the SSE snapshot, so they survive reconnects and show on every attached device. The **first answer wins**; a later answer gets `409`.
- Stop and Close cancel pending requests through the harness's cancel path.

### Config dirs

| | Pi | omp |
|---|---|---|
| Agent dir | `PI_CODING_AGENT_DIR` or `~/.pi/agent` (via `getAgentDir()`) | `~/.omp/agent` (or `OMP_AGENT_DIR`) |
| Sessions | `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting > `<agentDir>/sessions` | `~/.omp/agent/sessions` (or `OMP_SESSION_DIR`) |

omp is a Pi fork and reads the **same variable names** (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`). Any `PI_*` value in this server's environment belongs to Pi and is stripped from omp children. `OMP_AGENT_DIR` and `OMP_SESSION_DIR` are mapped onto omp's names for the child only. Overrides are reported as set/unset only. The app never writes inside `~/.pi` or `~/.omp`, and the browser never sees agent dirs or session file paths.

## Security

- Binds only `127.0.0.1`. No CORS. `Host` must be loopback or in `ALLOWED_HOSTS`, and `Origin` must match `Host`. `Sec-Fetch-Site: cross-site` is refused. These failures return `403`.
- **Authentication.** A per-process launch token is accepted only on `GET /`. It is exchanged for an HMAC-signed cookie bound to that `host:port`: `HttpOnly`, `SameSite=Strict`, ~30 days, and `Secure` on Serve hosts. `/api` and SSE without that cookie return `401`. The signing secret persists in `~/.local/state/agent-web-ui/cookie-secret` (0600), so restarts don't sign devices out; delete it to revoke every device.
- **Remote fails closed.** Any non-loopback `Host` counts as Tailscale Serve and is refused unless `ALLOWED_TAILSCALE_USERS` is set and Serve's `Tailscale-User-Login` matches. That header is trustworthy only because the backend listens on localhost. **Any local process can forge it** by talking to `127.0.0.1:4783` directly; the cookie still applies.
- Credentials are never read, returned, or logged. Each harness uses its own local auth, and there is no browser login form.
- No shell endpoint. Strict CSP (`'self'` only, no inline script or style, no CDNs), `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'`.
- Markdown: raw HTML is dropped. Links are limited to `http`/`https`/`mailto`, and remote images are not loaded.
- **Neither Pi nor omp sandboxes itself.** They run as you with their full tool set, and **Tailscale is network access, not a sandbox.** Anyone who can use this UI can make the agent run commands as you.

## Tailscale

Do this after localhost works:

```bash
ALLOWED_HOSTS=<machine>.<tailnet>.ts.net ALLOWED_TAILSCALE_USERS=<your-login> npm start
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

`--bg` persists the proxy configuration; it does not start this Node app. Never use Funnel. With `ALLOWED_HOSTS` set, startup also prints `Serve: https://…/?token=…`. Open that link once on your phone, or use **Pair phone** in the sidebar. The token changes on each restart, but paired devices stay signed in.

## Theme

The built-in light and dark themes follow your system. A base16 or base24 scheme file replaces them and is listed in the theme menu by its name (a per-device choice).

- **Accepted formats:** tinted-theming (`system`, `name`, `variant`, nested `palette:`), the stylix-generated shape (`name` + `palette:`, hex without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
- **Validation:** only exact 6-digit hex is accepted, because colors become CSS custom properties applied through the CSSOM.
- **Contrast:** roles are checked against WCAG AA (4.5:1 for text, 3:1 for controls and focus) and nudged if needed. Adjustments are logged.
- **Live updates:** the file is re-resolved (realpath and mtime) on each request, so a home-manager switch shows up the next time a tab becomes visible.
- **Fonts:** an optional `fonts.sans` / `fonts.mono` goes first in the font stacks, with system fallbacks.

### Wiring it to stylix (NixOS / home-manager)

[`contrib/home-manager/agent-web-ui-theme.nix`](contrib/home-manager/agent-web-ui-theme.nix) mirrors `home/common/core/pi-theme.nix`. It writes `xdg.configFile."agent-web-ui/theme.yaml"` from:

- `config.lib.stylix.colors.scheme`
- `config.stylix.polarity`
- every `baseXX` key (base24 included)
- `config.stylix.fonts.{sansSerif,monospace}.name`

To install it:

1. Copy it to `~/dotfiles/NixOS/home/common/core/agent-web-ui-theme.nix`.
2. Add `./core/agent-web-ui-theme.nix` to the imports in `home/common/default.nix`.
3. Rebuild.

Changing `stylix.base16Scheme` in `shared/stylix.nix` then re-themes the web UI. Until the module is installed, you can point `THEME_FILE` at `~/.pi/agent/themes/stylix.yaml`.

## Optional autostart (home-manager)

Nothing is installed imperatively. [`contrib/home-manager/agent-web-ui-service.nix`](contrib/home-manager/agent-web-ui-service.nix) defines `systemd.user.services.agent-web-ui`: absolute `${pkgs.nodejs}` and server entry, bound to `127.0.0.1`, no secrets, and a `PATH` that finds `pi` and `omp`. Add it next to the theme module, set the commented `ALLOWED_*` lines if you use Serve, and rebuild.

```bash
systemctl --user status agent-web-ui
journalctl --user -u agent-web-ui -n 20     # shows the Local:/Serve: token URLs
systemctl --user stop agent-web-ui
# uninstall: drop the import, rebuild
```

`npm start` keeps working either way.

## Testing

- `npm test` runs security (Host/Origin/cookie/Tailscale), API + SSE flows (send, steer, follow-up, stop, replay without duplicates, resnapshot, single writer, approvals, bounded output), theme parsing and contrast, config, and the **omp adapter against a scripted `omp`** (`tests/fixtures/fake-omp.mjs`, which speaks rpc-ui and ACP).
- `npm run test:e2e` runs Playwright against the built server with two fake harnesses. It covers sign-in, streaming, harness switch, steer and follow-up, stop, approvals, offline reconnect, reload and resume, markdown safety, theme contrast, the process fold, stacked approvals, the todo status stack, the context ring, changed files, the turn rail, harness-grouped sessions, chat text size, and 390×844 and 320 px layouts.
- `npm run smoke` runs the real Pi and omp: discovery, a session with the harness's normal tools, config, session listing, and Pi resume-after-restart (from a session written by Pi's own `SessionManager`). It never calls a model unless `SMOKE_MODEL=<provider/model>` names a model already configured in both harnesses; then it also runs prompt → stream → stop → resume. Prefer a local model so it costs no tokens. It never starts a model server.

**NixOS.** Playwright browsers come from nixpkgs through `PLAYWRIGHT_BROWSERS_PATH`, and `@playwright/test` is pinned to the same version (1.63.0). Never run `npx playwright install`. Check the version with:

```bash
nix eval --raw ~/dotfiles/NixOS#nixosConfigurations.$(hostname).pkgs.playwright-driver.version
```

## Design credits

The interface borrows patterns, not code, from three MIT-licensed projects:

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (© 2026 DeepSeek):
  - plain answers with user bubbles;
  - the "Worked for …" process fold and its one-line disclosure rows;
  - the tool input/output card;
  - the composer card with settings inside and the centred empty-chat composer;
  - approvals in the composer;
  - the context ring and the turn rail;
  - the neutral built-in palette.
- **[OpenCode](https://github.com/anomalyco/opencode)** (© 2025 opencode): tool counts on the fold line, changed files per turn, and the Deny / Approve button order.
- **[Hermes Desktop](https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop)** (© 2025 Nous Research):
  - "flat, not boxed";
  - pinned prompts;
  - the composer status stack with its ridge;
  - stacked approval cards;
  - red reserved for real failures;
  - chat text size separate from page zoom;
  - the bottom status bar;
  - an animated loader instead of "Loading…".

## Not included (by design)

Profiles, voice, side agents, browser editing of auth, settings, trust, or theme files, a remote file editor, direct provider APIs, a second database, a full session-tree UI (only the active branch is shown), a generic ACP adapter (designed for, not built), public deploy or Funnel, telemetry, and share links.
