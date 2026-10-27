# Finding and fixing a part of the web UI

How to go from "this part of the UI is broken" (or "looks off") to the file
that draws it, a way to see it without touching anyone's real chats, and a
check that the fix holds. The rules in AGENTS.md (House style, Web UI) still
apply: no hard-coded colours, no inline styles (the CSP refuses them), every
control reachable by keyboard and named for screen readers.

## 1. Wrong data, or wrong drawing?

The server decides **what** is shown; the web UI only decides **how**.

- **Wrong content** (a missing tool call, a reply in the wrong place, a
  duplicated message, a stale status) usually comes from the server: the
  adapter that translated the harness (`src/server/harness/<id>.ts`, see
  docs/harnesses.md) or the reducer that folds its events into items
  (`src/server/chats/chat.ts`). Check the chat's items first:
  `curl -s http://127.0.0.1:4783/api/chats/<chatId> | python3 -m json.tool`.
  Turns are grouped on the client in `src/web/turns.ts` (shared with atui), so
  a turn-level ordering bug lives there.
- **Wrong drawing** (size, spacing, colour, overflow, a control that does not
  respond) is the component and its stylesheet below.

What the client gets: `/api/bootstrap` (harnesses with their capabilities,
colours, and setup commands; the theme; UI settings; workspace roots; limits)
once, then for the open chat
a snapshot plus live events over SSE (`chat-stream.ts`, `stream.ts`).
Components draw from those; they never call a harness.

## 2. Where each part lives

`App.tsx` is the shell: it owns which chat is shown and hands each region its
props. Styles are `src/web/styles/*.css`, imported in cascade order by
`src/web/styles.css`. Find a class's rules with
`rg -n '^\.<class>\b' src/web/styles/`: a few areas keep rules in a file named
after another section (an embedded page's under subagents.css, dialogs under
banners-dialogs.css), so search rather than guess.

| Region | Components | Main styles | Covered by |
|---|---|---|---|
| Page frame, header, status bar | `App.tsx`, `StatusBar.tsx` | `app-frame.css`, `header.css` | `app.spec.ts` |
| Sidebar: harness, projects, sessions | `Sidebar.tsx`, `HarnessMenu.tsx`, `SessionCard.tsx`, `SidebarResizer.tsx`, `WorkingRing.tsx` | `sidebar.css`, `session-card.css` | `app.spec.ts`, `tabs.spec.ts` |
| Session tabs | `TabStrip.tsx` | `session-tabs.css` | `tabs.spec.ts` |
| Conversation: turns, answers, thoughts | `Conversation.tsx`, `Markdown.tsx`, `CodeBlock.tsx`, `QuoteButton.tsx`, `TurnRail.tsx`, `StickyPrompt.tsx` (`sticky-prompt.ts`) | `conversation.css` | `app.spec.ts` |
| Tool rows and their bodies (diffs, terminals) | `ToolBody.tsx` (inside `Conversation.tsx`) | `conversation.css` | `app.spec.ts` (tool cards) |
| Subagents, agent-rendered pages, plans | `Subagents.tsx`, `HtmlRenderFrame.tsx`, `PlanCard.tsx` | `subagents.css`, `plan-card.css` | `app.spec.ts`, `composer-extras.spec.ts` |
| Empty chat, opening a chat | `App.tsx` (hero), `SwitchSplash.tsx`, `Loader.tsx` | `hero.css`, `opening-chat.css`, `loader.css` | `app.spec.ts`, `tabs.spec.ts` |
| Composer card and its row of controls | `Composer.tsx`, `ChipEditor.tsx` (the box, its chips: `draft-chips.ts`), `ComposerControls.tsx`, `ModelPicker.tsx`, `ThinkingPicker.tsx`, `PermissionPicker.tsx`, `HarnessMenu.tsx` (chip), `ContextRing.tsx` | `composer.css`, `model-picker.css` | `app.spec.ts` |
| Composer extras: stash, link note, usage-limit banner | `Composer.tsx`, `LimitRecovery.tsx` | `composer-extras.css` | `composer-extras.spec.ts` |
| Status stack (todos, queue, chain) and the git row | `StatusStack.tsx`, `GitStatusView.tsx` | `status-stack.css`, `queue-edit.css`, `chain.css` | `app.spec.ts`, `unified.spec.ts` |
| Approvals and questions | `ApprovalStack.tsx` | `approvals.css` | `app.spec.ts` |
| Dialogs: settings, folders, restore, palette, images | `Dialog.tsx`, `SettingsDialog.tsx`, `WorkspacePicker.tsx`, `RestoreDialog.tsx`, `HerdrDialog.tsx`, `CommandPalette.tsx`, `ImageViewer.tsx`, `LoginForm.tsx` | `banners-dialogs.css`, `settings.css` | `settings.spec.ts`, `app.spec.ts`, `herdr.spec.ts`, `remote-login.spec.ts` |
| Searches: every chat, in project, find in chat | `ChatSearch.tsx`, `ProjectSearch.tsx`, `find.ts` | `chat-search.css`, `project-search.css`, `find.css` | `unified.spec.ts`, `composer-extras.spec.ts` |
| File viewer, review, file timeline | `FileViewer.tsx`, `ReviewPanel.tsx`, `TimelineDialog.tsx` | `file-viewer.css`, `timeline.css` | `unified.spec.ts` |
| Usage and limits | `UsageDialog.tsx`, `LimitsMeter.tsx` | `usage.css` | `unified.spec.ts` |
| Saved prompts, shortcuts | `SavedPromptsDialog.tsx`, `ShortcutSheet.tsx` | `saved-prompts.css`, `shortcuts.css` | `unified.spec.ts` |
| A chat beside the main one | `SidePane.tsx` | `side-pane.css` | `unified.spec.ts` |
| Phones: drawer, sheets, long press | `ActionSheet.tsx`, `gestures.ts` | `phones.css`, `responsive.css` | `phone.spec.ts` |
| Motion and the ripple | `ripple.ts` | `motion.css`, `ripple.css` | `app.spec.ts` |

Every component opens with a comment saying what it draws and why it is
shaped that way; read it before changing the file.

**Narrow screens and touch.** `responsive.css` (≤ 819 px: one column, the
sidebar becomes a drawer) and `phones.css` (touch sizes, sheets) override the areas
imported before them; the areas imported after them carry their own `@media`
rules. A fix that looks right on a desktop can be undone there: check both.

## 3. The design tokens

All in `src/web/styles/tokens.css`. A base16 theme replaces the base colours
(`theme.ts`); everything else is mixed from them, so a fix uses a token, never
a literal colour.

- **Colours:** `--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`,
  `--muted`, `--accent`, `--link`, `--ok`, `--warn`, `--danger`; derived
  `--hairline`, `--hairline-strong`, `--hover`, `--active`. A harness's colour
  is `--harness`, set per element by `harnessColor()` from its `accent`.
- **Radii:** `--r-xs` 4, `--r-sm` 8, `--r-md` 12, `--r-lg` 16, `--r-xl` 20,
  `--r-panel` 24 (px). Pills and round buttons use `999px` / `50%`.
- **Widths:** `--col` 960 px (review drawers), `--chat-col` (the conversation
  and composer; config.yml's `chat_width`), `--sidebar-w`.
- **Text:** `--chat-font` = 14.5 px × `--chat-scale` (config.yml's text size).
- **Control sizes:** the composer's row is 32 px tall, every control in it
  round; phones raise touch targets to 36–44 px in `phones.css`. Keep a row of
  controls one height: mismatched heights and radii are what makes a part
  "look off".
- **Motion:** short and eased out; `prefers-reduced-motion` turns it all off
  (the rule at the end of `tokens.css`).

## 4. See it without touching real chats

The user's server (port 4783) holds their live chats: look at it, don't
experiment on it. Run a sandbox with the fake harnesses instead, in tmux, and
tear it down afterwards:

```bash
npm run build                                   # the built UI; or use npm run dev below for hot reload
SB=$(mktemp -d); mkdir -p $SB/projects/demo $SB/state
tmux new-session -d -s awui-sandbox "AWUI_CONFIG_DIR= AWUI_HARNESSES=fake,fake-b AWUI_HERDR=0 \
  PORT=4795 WORKSPACE_ROOTS=$SB/projects XDG_STATE_HOME=$SB/state node dist/server/server/index.js"
B=http://127.0.0.1:4795
WS=$(curl -s -X POST $B/api/workspaces/open -H 'content-type: application/json' \
  -d "{\"path\":\"$SB/projects/demo\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
CID=$(curl -s -X POST $B/api/chats -H 'content-type: application/json' \
  -d "{\"harnessId\":\"fake\",\"workspaceId\":\"$WS\"}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read(),strict=False)["chatId"])')
curl -s -X POST $B/api/chats/$CID/messages -H 'content-type: application/json' \
  -d '{"text":"make a todo list and edit things","mode":"normal"}'
# … look, measure, fix …
tmux kill-session -t awui-sandbox                # then check: nothing listens on 4795
```

With the same variables, `npm run dev` serves the UI from Vite on
http://127.0.0.1:5173 with hot reload instead.

The fake harness answers scripts chosen by words in the prompt, so any state
can be produced on demand: `tool`, `edit`, `showcase` (one call of every tool
kind), `todo`, `ask` (an approval), `quiz` (a question), `subagents`, `planned`,
`ratelimit`, `slow` (to act mid-run), `fail`, and the rest listed in
`src/server/harness/fake.ts` and AGENTS.md (Testing). `fake-b` declares fewer
capabilities, for checking what hides.

## 5. Measure it

```bash
node scripts/ui-shot.mjs "$B/#chat=$CID" ".composer" /tmp/composer.png            # desktop, dark
node scripts/ui-shot.mjs "$B/#chat=$CID" ".composer" /tmp/composer-phone.png --phone
```

It prints every control inside the selector with its size, radius, padding,
and font, and saves a screenshot of that element (`--phone`, `--narrow`,
`--light` switch the viewport and scheme). Read the numbers before the
picture: the composer once mixed 30 px pills, a 34 px send button, square and
round hovers, and a chip narrower than it was tall, and the table showed all of
it at a glance. Run it inside `devenv shell` on NixOS (Playwright's browsers
come from nixpkgs). For the full set of reference frames, use
`AWUI_SCREENSHOTS=<dir> npx playwright test screenshots`.

## 6. Check the fix

- Measure again: the numbers you meant to change changed, and nothing else.
- `npm run typecheck`, then the e2e spec that covers the region (table above):
  `npx playwright test tests/e2e/<spec> --reporter=line` after `npm run build`.
  The whole suite (`npm run test:e2e`, ~3 min) before a commit that moves
  layout.
- Look at a phone viewport and at the light scheme; tab through the controls
  you touched.
- For a pure move of CSS (splitting or reordering files), build before and
  after and compare `dist/web/assets/index-*.css`: it must be byte for byte the
  same.
