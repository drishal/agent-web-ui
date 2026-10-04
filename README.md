# agent-web-ui

A local, private, responsive web UI for the **Pi**, **omp** (oh-my-pi), and **Hermes** (hermes-agent) coding-agent harnesses. Use it from your desktop browser or, through Tailscale Serve, from your phone.

The browser is only a control surface. Each harness remains the agent and the source of truth for its own models, authentication, settings, tools, resources, trust decisions, and session files. This app never edits session files and keeps no second transcript database.

```
browser ──HTTP/SSE──▶ Node server (127.0.0.1:4783) ──▶ HarnessAdapter
                                                        ├─ Pi     (in-process SDK, @earendil-works/pi-coding-agent 1.0.0)
                                                        ├─ omp    (child process: `omp --mode rpc-ui`, one per live chat)
                                                        ├─ Hermes (child process: `python -m tui_gateway.entry`, one per live chat)
                                                        └─ fake   (tests only)
```

## Install and run

Requirements: Node ≥ 22.19 (24 LTS recommended), npm, and `pi`, `omp`, and/or `hermes` installed and logged in. A missing harness shows as unavailable instead of crashing the app.

```bash
npm ci
npm run build
npm start            # serves UI + API on http://127.0.0.1:4783
```

Open http://127.0.0.1:4783/ on this machine. No token and no sign-in: local use is open.

Settings live in `~/.config/agentwebui/`: `config.yml` (start from [`config.example.yml`](config.example.yml)) and, optionally, a base16 `theme.yml`. To use it from other devices (LAN and/or Tailscale Serve), set:

```yaml
host: 0.0.0.0          # prints LAN: http://<ip>:4783/ for each address
auth:
  username: you
  password: your-password
```

then restart. Other devices get a sign-in form; this machine still opens directly. If you would rather not keep the password in a file, leave it out and run `npm run set-password` instead (it stores only a scrypt hash).

| Script | What it does |
|---|---|
| `npm run dev` | Backend under `tsx watch` plus Vite on :5173, proxying `/api`. Prints a `Dev UI: http://127.0.0.1:5173/` link. |
| `npm run set-password` | Alternative to `auth.password`: sets the login for other devices, storing a salted scrypt hash only. Changing it signs every device out. |
| `npm run typecheck` | Strict TypeScript for server, web, and tests |
| `npm test` | Vitest unit and integration tests. Uses only fake and scripted harnesses, so no model tokens are spent. |
| `npm run test:e2e` | Builds, then runs Playwright (Chromium) against the fake harnesses |
| `npm run smoke` | Opt-in checks against the real installed Pi, omp, and Hermes (see [Testing](#testing)) |
| `npm run build` / `npm start` | Production build, then a single process serving UI and API |

### Configuration (`~/.config/agentwebui`)

**`config.yml`** (YAML, so it can carry comments; every key optional). It is read at startup; `theme` and `autocollapse_sidebar` are re-read on every page load. An unknown key or a wrong type stops the server with the key named (exit 78, which the autostart unit does not retry), rather than being guessed at.

| Key | Default | Meaning |
|---|---|---|
| `port` | `4783` | 1024–65535. |
| `host` | `127.0.0.1` | `127.0.0.1` (this machine only, no sign-in) or `0.0.0.0` (LAN; other devices sign in). Nothing else is accepted. |
| `auth.username`, `auth.password` | — | Login for other devices. `host: 0.0.0.0` and `allowed_hosts` need a login (this or `set-password`), otherwise the server refuses to start. A `config.yml` holding a password is kept at mode 0600, and the password never enters the server's environment, so the agents' shells never see it. |
| `workspace_roots` | home dir | Projects must be inside a root, checked by realpath, so symlink and `..` escapes are refused. |
| `allowed_hosts` | — | Extra `Host` values (e.g. your `*.ts.net` Serve name). |
| `allowed_tailscale_users` | — | Optional Tailscale logins; when set, Serve requests must also carry one of them. |
| `theme` | — | Default look on every device: `system`, `light`, `dark`, or `base16` (`theme.yml`; `custom` is accepted as the old name). Unset: `theme.yml` when there is one, else `system`. The theme menu changes it per device; a changed value here wins once on each device. |
| `autocollapse_sidebar` | `true` | Fold the sidebar away below 1200 px wide (phones use the drawer anyway); a sidebar collapsed with its button stays collapsed at any width. |

**`theme.yml`**: a base16/base24 scheme (see [Theme](#theme)); the dotfiles' stylix module writes it.

**Environment variables** win over `config.yml`, for services and tests:

| Variable | Meaning |
|---|---|
| `PORT`, `HOST`, `AUTH_USERNAME`, `AUTH_PASSWORD` | As the keys above. |
| `WORKSPACE_ROOTS`, `ALLOWED_HOSTS`, `ALLOWED_TAILSCALE_USERS` | As the lists above (`:`-separated roots, comma-separated hosts and users). |
| `AWUI_CONFIG_DIR` | Another settings folder; empty ignores `config.yml` (the tests do this). |
| `THEME_FILE` | Another theme file. |
| `AUTH_CREDENTIALS_FILE` | Login written by `npm run set-password` (default `$XDG_STATE_HOME/agent-web-ui/credentials.json`); used when no password is configured. |
| `OMP_AGENT_DIR`, `OMP_SESSION_DIR` | Overrides for omp only (see [Config dirs](#config-dirs)). |
| `XDG_STATE_HOME` | The cookie-signing secret lives in `agent-web-ui/cookie-secret` (mode 0600). |

## Using it

- **Sidebar.** New chat, the harness switcher, and the project come first. Below them sit session search and the sessions of **every project**, grouped by folder like Hermes Desktop: the current project first, then the rest by their newest session, each with Today / Yesterday / Earlier this week / month headings and *Show N more in …*. Search covers all projects and the selected harness's sessions; a dot on each row marks its harness (the Pi/omp/Hermes switch, which scopes the list and picks the harness for new chats, is the legend), and a spinning ring marks a session that is working. Clicking a session in another project switches to that project, and a project row's **+** starts a new chat there. Only folders inside `WORKSPACE_ROOTS` that the harness can open are listed. A green dot means the session is already open in this server; clicking it attaches to that chat rather than opening a second writer. The footer holds the theme, the chat **text size** (scales the conversation and composer only, per device), and *Pair phone*. Drag the sidebar's right edge to resize it (200–560 px, remembered per device). The panel button at its top right folds it away, and the chat header gets one to bring it back. Narrower than 1200 px (a vertical monitor, a tiled half screen) it folds away by itself and returns when the window widens (`autocollapse_sidebar`); reopened by hand it stays open until the width crosses back, and one you collapsed yourself stays collapsed at any width. The handle also takes arrow keys (Shift for bigger steps) and Home/End, and double-clicking resets it.
- **Harness switcher.** Pi, omp, or Hermes. Switching scopes the sidebar to that harness's own sessions and picks the harness for new and resumed chats; open chats stay on the harness that created them.
- **Project.** Recent folders, a folder browser that walks `WORKSPACE_ROOTS` one level at a time, or a typed path.
- **New chat.** Opens as a centred composer.
- **Each turn** shows:
  - your prompt as a bubble that stays pinned while you scroll through a long turn;
  - one **"Worked for 12s · 3 reads, 1 edit"** line folding the agent's thinking, intermediate notes, tool calls, and approvals (open while running, collapsed after);
  - the answer as plain text with a Copy button;
  - **Fork from here** on a finished answer: the session is copied through that turn into a new chat and opens in its place. Pi branches with its own primitive (`createBranchedSession`); omp gets a new session file cut to the same branch. Not offered for Hermes, which has no fork.
  - a **Changed N files** list for edits and writes.
- **Inside the fold.** Each step is a single quiet line (`read · src/app.ts`); click it for the input/output panel. Red appears only for real failures.
- **Composer card.**
  - Model and thinking sit inside the card. The **model picker** is a searchable popover (a bottom sheet on phones):
    - matching ignores punctuation and spacing, across provider, name, and id, so `gpt55` finds GPT-5.5;
    - models are grouped by provider, with recently used ones first and the current one checked;
    - ↑/↓, Page Up/Down, Enter, and Esc work from the search box. Tools are never narrowed: every chat uses the harness's normal tool set, extension tools included.
  - The **context ring** shows how full the context window is. Click it for one panel in DeepSeek Harness's three sections:
    - **Context:** what fills the window, as a coloured bar and a list. For omp these are omp's own `/context` categories (system prompt, system tools, system context, skills, messages). The adapter runs `/context` over RPC only while omp is settled and only after `get_available_commands` lists it as a builtin, so it never reaches the model. Pi has no breakdown of its own (its `/context` is an extension that draws in the terminal), so the server estimates the system prompt, the declared tool definitions (~4 chars a token), and the messages (Pi's `estimateTokens`).
    - **Tokens this session:** cache hit, uncached input, cached input, output, and cost when the harness prices the model (Pi `getSessionStats`, omp `get_session_stats`).
    - **Session:** turns and model calls (steps), LLM time, average time to first token, and tokens per second. No harness reports timing, so the server measures it from the stream: a call starts at the prompt or the last tool result, its first token is its first delta, and its output tokens come from the provider's usage.
  - Builtin omp commands typed into a chat (`/context`, `/usage`, …) run in omp itself: no model call, the output is the answer.
  - **"/" commands:** typing `/` opens a menu (Hermes Desktop's) of what the chat's harness offers: Pi's extension commands, prompt templates, and `skill:` commands; omp's `get_available_commands` (only what runs over RPC); Hermes's `complete.slash`. The app adds `/new`, `/compact [focus]`, and `/rename <title>` for every harness. Typing filters (name, then description), ↑/↓ move, Tab or Enter completes, Enter on a complete command that takes nothing runs it, Esc closes. Pi and omp run a command sent as the prompt; Hermes runs it the way its TUI does (`slash.exec`, then `command.dispatch` for skills and plugins). A command that runs without a model turn shows as the prompt, with its output as the answer (preformatted, since it is terminal text).
  - **Images:** paste a screenshot, drop image files on the card, or use the image button (handy on phones). Up to 8 per message; they show as thumbnails you can remove, and go with the prompt, a steer, or a follow-up. PNG, JPEG, GIF and WebP under 5 MB go as-is (the harness resizes them for the model); anything bigger or of another type is redrawn at most 2048 px on its long side. An image needs some text with it, since some providers reject an empty text block. A model that does not take image input gets a warning. Pasting from a spreadsheet or rich editor, which copies a rendering beside the text, pastes the text.
  - While a run is active you get **Steer**, **Follow-up**, and **Stop**. A harness without steer offers only **Stop and send**, labelled exactly that.
  - Enter sends; on touch devices Enter adds a newline and you tap Send.
- **Status stack** above the composer: queued steering/follow-up messages, the harness's todos (omp), and extension status. Hide it with the ridge (remembered per chat).
- **Approvals and dialogs** take over the composer card. Several pending requests stack, the first answer wins, and Stop cancels them.
- **Turn rail** on the right (wide screens): one mark per turn; hover for the prompt, click to jump.
- **Status bar** at the bottom (desktop): connection, harness · model · thinking, project path, version. Phones show a banner only when the connection drops.
- **Chat menu (⋯):** Rename, Compact context, Close chat.
- **Buttons** show a Material-style ink ripple: it grows from where you press, fades on release, starts from the centre for Enter/Space, and is off when your system asks for reduced motion.

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
  harness/hermes.ts         Hermes adapter (tui_gateway JSON-RPC child process)
  harness/fake.ts           deterministic adapter for tests
  chats/chat.ts             one live chat: state fold, event log, SSE fan-out, commands
  chats/manager.ts          chat registry, one live writer per native session
  security.ts               Host/Origin/Tailscale checks, local-vs-remote, password sessions
  auth.ts                   scrypt credentials and sign-in lockout
  workspaces.ts             roots, realpath confinement, folder browsing
  theme.ts                  base16/base24 parsing, contrast-checked CSS variables
  app.ts, index.ts          Express 5 routes, SSE, startup/shutdown
src/web/                    React + Vite client
```

**Single writer.** `chatId → live session` and `harnessId + native session id → chatId` mean the same session is never opened twice in this process. For omp that also means never two child processes. A second tab or device attaches to the existing chat as another SSE subscriber. **Another terminal or process running `pi`/`omp`/`hermes` is not locked out.** Avoid driving the same session from a terminal while it is open here.

**Run lifecycle.** A run is not marked complete at a message end or a bare `agent_end`. Pi's `agent_settled` and omp's `session_settled`/`prompt_result.sessionSettled` decide it. Sends return `202` once the harness accepts them; output streams over SSE.

**Runs outlive the browser.** A run belongs to the server, not to a tab: close the browser mid-run and it carries on, and any device that opens the chat later (another browser, your phone over LAN or Tailscale) attaches to the same live chat and picks up from the snapshot. A chat waiting on an approval waits for an answer from any device. Only a chat that is idle, has no viewers, and has been quiet for 30 minutes is closed, and its session file stays, so opening it again resumes it.

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
| `session/list` | `listSessions()` / `listRecentSessions()` |
| `session/cancel` | `abort()` |
| session config options | model / thinking / mode |

ACP has no standard steer or follow-up, so an ACP adapter declares `supportsSteer: false` and `supportsFollowUp: false`. Pi and omp do **not** use ACP here. omp's ACP mode cancels a running turn when a new prompt arrives instead of steering, and Pi has only third-party bridges.

### Pi

Pi runs in-process through the pinned SDK (`createAgentSessionServices` → `createAgentSessionFromServices`). It loads Pi's normal global and project settings, AGENTS files, skills, prompt templates, extensions, and custom models through Pi's own loader. Extensions get a web `ExtensionUIContext`: `select`, `confirm`, `input`, and `editor` become dialog cards, `notify` becomes a notice, and status/widgets become chips. TUI-only calls (`custom`, footers, themes) are no-ops.

**Trust.** The SDK trusts project folders by default; the Pi CLI does not. This adapter mirrors the CLI and never prompts: it uses the stored decision in Pi's trust store, then your `defaultProjectTrust` setting, and otherwise does not trust the folder. A skipped folder shows a notice telling you to run `pi` there once.

Tools are Pi's normal active set (your `defaultTools` plus extension tools); this host never narrows them. Model and thinking changes use `persist: false`, so the web UI never rewrites your Pi defaults.

### omp

omp's npm package requires Bun and ships raw `.ts`, so it cannot be imported into this Node server. Each live chat therefore runs the **installed** `omp` in `--mode rpc-ui`, one child process per chat. `rpc-ui` is the mode with tool-approval and extension-UI requests over the protocol; plain `rpc` has no UI, so approvals would fail closed.

- **Listing:** omp's RPC has no session listing, so a short-lived `omp acp` process answers `session/list` (with a `cwd` for one project, without one for the sidebar's newest sessions across projects) and exits after 60 s idle. `session/list` carries only omp's stored title, which stays empty when omp never generated one; like omp's own picker, the adapter then shows the first prompt, read from the first 64 kB of that session's file (read-only, cached by size).
- **Resume:** `--resume <id>` with `--cwd`. The adapter checks that omp opened exactly that session.
- **Transport:** omp's protocol v1 caps every frame at 1 MiB, so a long session's `get_messages` fails ("RPC response exceeded the transport limit") and big events are trimmed. When omp's ready frame offers protocol v2, the adapter negotiates it and joins the `rpc_chunk` slices (up to 64 MiB a frame). If a history still cannot load, the chat fails with omp's reason and its omp process is closed again.
- **Tools:** omp starts with its normal tool set. The app never passes `--tools`.
- **Home directory:** omp refuses to work in your home directory itself (it would switch to a temp dir), so the UI disables omp for a workspace that is exactly `~`. It never passes `--allow-home`.
- **Lifecycle:** children are killed on dispose and on `SIGINT`/`SIGTERM`. A crash surfaces as a chat error. Protocol types are hand-written from omp 18.4.5 and checked against **18.4.10**: newer minors are assumed additive and stay quiet, while an older build or a different major line shows a warning.

### Hermes

Each live chat runs Hermes's own gateway, `python -m tui_gateway.entry`, as a child process and speaks its newline-delimited JSON-RPC over stdio. That is the transport the Hermes TUI and its dashboard chat tab use.

- **Environment:** the TUI starts the gateway with its own environment, and it runs under the `hermes` launcher, so the gateway inherits what the launcher sets up. On Nix that is `HERMES_PYTHON`, `HERMES_BUNDLED_PLUGINS`/`SKILLS`/`LOCALES`, `HERMES_INSTALL_ROOT`, and a `PYTHONPATH` with plugin dependencies such as mnemosyne. This server is not started by the launcher, so it replays the launcher's setup once (everything before its final `exec`, under the launcher's own shell) and starts the gateway with the result. An explicit `HERMES_PYTHON` skips this; a launcher that is not a shell wrapper falls back to `python3` on `PATH`.
- **Sessions:** `session.create` / `session.resume` / `session.close`; listing comes from `projects.tree` rows in a short-lived probe child. Opening a chat without sending anything leaves no session in Hermes's history.
- **Runs:** `prompt.submit` (images via `image.attach_bytes`), streamed as `message.*`, `reasoning.delta`, and `tool.*` events; `session.interrupt` stops. Steer and follow-up both submit, and the gateway decides whether to queue.
- **Decisions:** `approval` and `clarify` server requests become approval and dialog cards. Prompts this UI cannot serve (sudo, secrets, vault, previews) are declined with a notice.
- **Config:** model and reasoning via `config.set` on Hermes's effort ladder (`none` … `max`); rename, compact (`session.compress`), todos, usage, and context come from the gateway. Hermes publishes no per-model effort levels, so its models carry no level chip.

### Approvals and extension dialogs

Tool approvals come from omp's `tools.approvalMode` (`always-ask` | `write` | `yolo`, as configured; this app never changes it or passes `--auto-approve`). Dialogs come from Pi or omp extensions (`select`, `confirm`, `input`, `editor`). Both become one `interaction_request`:

- It takes over the composer and stays in the conversation as a card that records the outcome.
- Pending requests are part of the SSE snapshot, so they survive reconnects and show on every attached device. The **first answer wins**; a later answer gets `409`.
- Stop and Close cancel pending requests through the harness's cancel path.

### Config dirs

| | Pi | omp | Hermes |
|---|---|---|---|
| Agent dir | `PI_CODING_AGENT_DIR` or `~/.pi/agent` (via `getAgentDir()`) | `~/.omp/agent` (or `OMP_AGENT_DIR`) | `HERMES_HOME` or `~/.hermes` |
| Sessions | `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting > `<agentDir>/sessions` | `~/.omp/agent/sessions` (or `OMP_SESSION_DIR`) | `~/.hermes/sessions` (jsonl; the `state.db` row is the source of truth) |

omp is a Pi fork and reads the **same variable names** (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`). Any `PI_*` value in this server's environment belongs to Pi and is stripped from omp children. `OMP_AGENT_DIR` and `OMP_SESSION_DIR` are mapped onto omp's names for the child only. Overrides are reported as set/unset only. The app never writes inside `~/.pi`, `~/.omp`, or `~/.hermes`, and the browser never sees agent dirs or session file paths.

## Security

- Binds `127.0.0.1` by default, or `0.0.0.0` with `HOST=0.0.0.0`. No CORS. `Host` must be loopback, in `ALLOWED_HOSTS`, or (with `HOST=0.0.0.0`) one of this machine's own LAN addresses or hostname. `Origin` must match `Host`, and `Sec-Fetch-Site: cross-site` is refused. These failures return `403`, which also blocks DNS rebinding and cross-site requests against the open local mode.
- **This machine needs no sign-in.** A request counts as local only when the TCP peer is loopback, the Host is loopback, and no proxy headers (`X-Forwarded-*`, `Forwarded`, `Tailscale-User-*`) are present. So a LAN client faking `Host: 127.0.0.1`, or Tailscale Serve proxying over loopback, is never local. The trade-off: any process or user on this machine can drive the agent through the UI. That is the same reach they already have by running `pi`/`omp`/`hermes` as you.
- **Other devices sign in** with `auth.username`/`auth.password` from `config.yml`, or the login from `npm run set-password`:
  - `set-password` stores only a salted scrypt hash, mode 0600. `auth.password` is plaintext in `config.yml` (forced to mode 0600) and is hashed in memory with a salt derived from the cookie secret, so restarts keep devices signed in.
  - Sign-in issues an HMAC-signed cookie bound to that `host:port` and to the credential fingerprint: `HttpOnly`, `SameSite=Strict`, ~30 days, and `Secure` on Serve hosts. Changing the password signs every device out.
  - Five wrong tries lock that address for 15 minutes, and every failure costs 400 ms.
  - Without a configured login, every non-local request is refused, and `HOST=0.0.0.0` or `ALLOWED_HOSTS` will not start.
- **LAN access is plain HTTP.** On your home network the password and chats are not encrypted; use Tailscale (HTTPS through Serve, or the encrypted tailnet) when you are away. NixOS's firewall also has to allow the port on the LAN interface (see below).
- If `ALLOWED_TAILSCALE_USERS` is set, Serve requests must also carry an allowed `Tailscale-User-Login` (trustworthy only because the backend is behind Serve).
- Harness credentials are never read, returned, or logged. Each harness uses its own local auth.
- No shell endpoint. Strict CSP (`'self'` only, no inline script or style, no CDNs), `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'`.
- Markdown: raw HTML is dropped. Links are limited to `http`/`https`/`mailto`, and remote images are not loaded.
- Attached images are checked by their magic bytes against the type they claim (PNG, JPEG, GIF, WebP only); only `POST …/messages` accepts a large body (8 × 5 MB), every other route keeps a small limit.
- **Neither Pi nor omp sandboxes itself.** They run as you with their full tool set, and **Tailscale is network access, not a sandbox.** Anyone who can use this UI can make the agent run commands as you.

## Tailscale

Do this after localhost works:

```bash
# in config.yml: auth.username, auth.password, and allowed_hosts: [<machine>.<tailnet>.ts.net]
npm start
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

`--bg` persists the proxy configuration; it does not start this Node app. Never use Funnel. Open `https://<machine>.<tailnet>.ts.net/` on your phone and sign in; **Pair phone** in the sidebar lists the addresses.

### LAN (`HOST=0.0.0.0`)

With `host: 0.0.0.0` in `config.yml`, startup prints `LAN: http://<ip>:4783/` for each address. NixOS blocks inbound ports by default, so open it on your LAN interface in the dotfiles, e.g. `networking.firewall.interfaces."enp14s0".allowedTCPPorts = [ 4783 ];` in `hosts/common/firewall.nix`. Prefer Tailscale over exposing it on Wi-Fi you do not control.

## Theme

The built-in light and dark themes follow your system. A base16 or base24 scheme in `~/.config/agentwebui/theme.yml` is listed in the theme menu as **base16** (its own name shows on hover); `theme: base16` in `config.yml` makes it the default everywhere.

- **Accepted formats:** tinted-theming (`system`, `name`, `variant`, nested `palette:`), the stylix-generated shape (`name` + `palette:`, hex without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
- **Validation:** only exact 6-digit hex is accepted, because colors become CSS custom properties applied through the CSSOM.
- **Contrast:** roles are checked against WCAG AA (4.5:1 for text, 3:1 for controls and focus) and nudged if needed. Adjustments are logged.
- **Live updates:** the file is re-resolved (realpath and mtime) on each request, so a home-manager switch shows up the next time a tab becomes visible.
- **Fonts:** an optional `fonts.sans` / `fonts.mono` goes first in the font stacks, with system fallbacks.

### Wiring it to stylix (NixOS / home-manager)

[`contrib/home-manager/agent-web-ui-theme.nix`](contrib/home-manager/agent-web-ui-theme.nix) mirrors `home/common/core/pi-theme.nix`. It writes `xdg.configFile."agentwebui/theme.yml"` from:

- `config.lib.stylix.colors.scheme`
- `config.stylix.polarity`
- every `baseXX` key (base24 included)
- `config.stylix.fonts.{sansSerif,monospace}.name`

To install it:

1. Copy it to `~/dotfiles/NixOS/home/common/core/agent-web-ui-theme.nix`.
2. Add `./core/agent-web-ui-theme.nix` to the imports in `home/common/default.nix`.
3. Rebuild.

Changing `stylix.base16Scheme` in `shared/stylix.nix` then re-themes the web UI. Until the module is installed, you can point `THEME_FILE` at `~/.pi/agent/themes/stylix.yaml`, or copy any base16 YAML to `theme.yml`.

## Optional autostart (home-manager)

Nothing is installed imperatively. [`contrib/home-manager/agent-web-ui-service.nix`](contrib/home-manager/agent-web-ui-service.nix) defines `systemd.user.services.agent-web-ui`: absolute `${pkgs.nodejs}` and server entry, no secrets, and the shell's `PATH` so `pi`, `omp` and the agents' tools are found. It sets no app settings, so `PORT`, `HOST` and the login come from `~/.config/agentwebui/config.yml`. It is skipped (not restart-looped) until `dist/` is built, and bad settings (such as `HOST=0.0.0.0` without a login) stop it with exit code 78 and the reason in the journal instead of restarting it every 5 seconds. Add it next to the theme module and rebuild. The unit runs the checkout's `dist/`, so after pulling: `npm run build && systemctl --user restart agent-web-ui`.

```bash
systemctl --user status agent-web-ui
journalctl --user -u agent-web-ui -n 20     # shows the Local:/LAN:/Serve: addresses
systemctl --user stop agent-web-ui
# uninstall: drop the import, rebuild
```

`npm start` keeps working either way.

## Testing

- `npm test` runs security (Host/Origin/cookie/Tailscale), API + SSE flows (send, steer, follow-up, stop, replay without duplicates, resnapshot, single writer, approvals, bounded output), theme parsing and contrast, config, the **omp adapter against a scripted `omp`** (`tests/fixtures/fake-omp.mjs`, which speaks rpc-ui and ACP), and the **Hermes adapter against a scripted `tui_gateway`** (`tests/fixtures/fake-hermes.mjs`: sessions, streaming, tools, approvals, interrupt, model/session listing).
- `npm run test:e2e` runs Playwright against the built server with two fake harnesses. It covers local access without sign-in, LAN sign-in on a real `HOST=0.0.0.0` server (wrong password, sign-in, sign-out), settings and login from `config.yml` (kept across restarts, revoked by a new password), a run that carries on after the browser closes and finishes in front of a second (phone-sized) browser, streaming, harness switch, steer and follow-up, stop, approvals, offline reconnect, reload and resume, markdown safety, theme contrast, the process fold, stacked approvals, the todo status stack, the context ring, changed files, the turn rail, sessions grouped by project (search, harness filter, *Show N more*, opening another project's session), chat text size, the button ripple (and its reduced-motion opt-out), sidebar resizing, the model picker (search, keyboard, recents, phone sheet), images (paste, drop, picker, remove, vision warning, send), the working spinner, and 390×844 and 320 px layouts.
- `npm run smoke` runs the real Pi, omp, and Hermes: discovery, a session with the harness's normal tools, config, session listing, and Pi resume-after-restart (from a session written by Pi's own `SessionManager`). It never calls a model unless `SMOKE_MODEL=<provider/model>` names a model already configured in both harnesses; then it also runs prompt → stream → stop → resume. Prefer a local model so it costs no tokens. It never starts a model server. Hermes needs its gateway interpreter: `HERMES_PYTHON` if set, otherwise the one the `hermes` launcher sets up, run with that launcher's environment (see [Hermes](#hermes)), otherwise `python3`.

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
  - the model picker anchored to the composer, with pinned provider headings;
  - the neutral built-in palette.
- **[OpenCode](https://github.com/anomalyco/opencode)** (© 2025 opencode): tool counts on the fold line, changed files per turn, the Deny / Approve button order, and model search that ignores punctuation, with recents.
- **[Hermes Desktop](https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop)** (© 2025 Nous Research):
  - "flat, not boxed";
  - pinned prompts;
  - the model picker's "Current" line;
  - the composer status stack with its ridge;
  - stacked approval cards;
  - red reserved for real failures;
  - chat text size separate from page zoom;
  - the bottom status bar;
  - an animated loader instead of "Loading…".

## Not included (by design)

Profiles, voice, side agents, browser editing of auth, settings, trust, or theme files, a remote file editor, direct provider APIs, a second database, a full session-tree UI (only the active branch is shown), a generic ACP adapter (designed for, not built), public deploy or Funnel, telemetry, and share links.

## License

MIT — see [LICENSE](LICENSE).
