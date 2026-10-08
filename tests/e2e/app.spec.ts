import { expect, type Page, test } from "@playwright/test";
import { chooseHarness, newChat, openSettings, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const status = (page: Page) => page.getByTestId("chat-status");
const answers = (page: Page) => page.getByTestId("answer");
const prompts = (page: Page) => page.getByTestId("user-prompt");

/** Open a finished turn's "Worked for …" fold. */
async function openFold(page: Page, index = -1) {
  const toggles = page.getByTestId("process-toggle");
  const toggle = index < 0 ? toggles.last() : toggles.nth(index);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("this machine opens straight into the app: no token, no sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  const res = await page.request.get("/api/bootstrap");
  expect(res.status()).toBe(200);
  expect((await res.json()).auth.mode).toBe("local");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("settings opens from the sidebar gear and shows pairing plus the server", async ({ page }) => {
  await signInAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pair phone" })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Theme" })).toBeVisible();
  await expect(settings.getByRole("slider", { name: "Chat text size" })).toBeVisible();
  // The e2e server runs without a settings folder, so the server section is read-only.
  await expect(settings).toContainText("nothing to save to");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

test("a new chat opens as a hero composer; a turn folds its work above a plain answer", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  await expect(page.getByText("It runs with its normal tools")).toBeVisible();
  await expect(page.getByTestId("tools-toggle")).toHaveCount(0);
  await sendAndWait(page, "hello tool **bold**");
  await expect(prompts(page)).toHaveText(["hello tool **bold**"]);
  await expect(answers(page).last().locator("strong", { hasText: "bold" })).toBeVisible();
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle).toHaveText(/Worked for \d+s · 1 read/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await openFold(page);
  const row = page.getByTestId("tool-row").last();
  await expect(row).toHaveAttribute("data-tool", "read");
  await expect(row).toHaveAttribute("data-status", "done");
  await expect(row).toContainText("README.md");
  await row.getByRole("button").first().click();
  await expect(row.locator(".tool-card")).toContainText("# Fake README");
  await expect(page.getByTestId("thought-row").last()).toContainText("Thought");
  await expect(page.getByRole("button", { name: "Copy reply" }).last()).toBeVisible();
});

test("an edit row carries its +N −M badge", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "please edit the app");
  await openFold(page);
  const row = page.getByTestId("tool-row").last();
  await expect(row).toHaveAttribute("data-tool", "edit");
  await expect(row.getByText("+1", { exact: true })).toBeVisible();
  await expect(row.getByText("−1", { exact: true })).toBeVisible();
  await row.getByRole("button").first().click();
  // Opened, it is the diff: the old line in red, the new in green.
  await expect(row.locator(".diff-line.is-del .diff-text")).toHaveText("a");
  await expect(row.locator(".diff-line.is-add .diff-text")).toHaveText("b");
});

test("tool cards: the harness's numbered diff, a terminal, a search, a fetch", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await openFold(page);
  const tool = (name: string) => page.locator(`[data-testid="tool-row"][data-tool="${name}"]`);
  for (const name of ["edit", "write", "bash", "grep", "web_fetch"]) await tool(name).getByRole("button").first().click();
  // Pi's own diff wins over the arguments': its line numbers, its skipped run, the changed words marked.
  const edit = tool("edit");
  await expect(edit.locator(".diff-line.is-add .diff-no").first()).toHaveText("11");
  await expect(edit.locator(".diff-gap")).toHaveCount(1);
  await expect(edit.locator(".diff-line.is-add .diff-word").first()).toHaveText(", host");
  await expect(edit.locator(".drow-aside")).toHaveText("+3 −2");
  await expect(tool("write").locator(".diff-line.is-add")).toHaveCount(4);
  await expect(tool("write").locator(".drow-aside")).toHaveText("+4");
  await expect(tool("bash").locator(".term-command")).toHaveText("$npm test -- --run tool-diff");
  await expect(tool("bash").locator(".term-output")).toContainText("5 passed");
  await expect(tool("grep").locator(".tool-chip")).toHaveText("listen\\(");
  await expect(tool("web_fetch").getByRole("link", { name: "https://example.com/docs/listen" })).toBeVisible();
  // Todos read as a checklist, never as JSON.
  await expect(tool("TodoWrite").locator(".drow-summary")).toHaveText("1/3 todos done · Shipping the diff view");
  await tool("TodoWrite").getByRole("button").first().click();
  await expect(tool("TodoWrite").locator(".todo-card-row.is-done")).toHaveText("Normalize each harness's diff");
  await expect(tool("TodoWrite").locator(".todo-card-row.is-active")).toHaveText("Ship the diff view");
  await expect(tool("todo_write").locator(".drow-summary")).toHaveText("Done: Normalize each harness's diff, Ship the diff view");
  await expect(page.getByTestId("process-toggle").last()).toContainText("1 file written");
});

test("an expanded thought shows its text once, not in the header and the body", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello thought");
  await openFold(page);
  const thought = page.getByTestId("thought-row").last();
  await expect(thought).toContainText("Considering: Echo: hello thought");
  await thought.getByRole("button").first().click();
  await expect(thought.locator(".thought-body")).toContainText("Considering: Echo: hello thought");
  // The header preview hides once open: the text appears exactly once.
  await expect(thought.getByText("Considering: Echo: hello thought", { exact: false })).toHaveCount(1);
});

test("switch harness without reloading; capabilities change the composer", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page, "Fake B");
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
  await send(page, "slow please");
  await expect(page.getByRole("button", { name: "Stop and send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill("change of plan");
  await page.getByRole("button", { name: "Stop and send" }).click();
  await expect(answers(page).last()).toContainText("Echo: change of plan", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await chooseHarness(page, "Fake");
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
});

test("the harness menu lists every harness in its own colour and works from the keyboard", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  const row = page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: "Harness" });
  await expect(row).toContainText("Fake");
  await row.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("listbox", { name: "Harness" });
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-selected", "true");
  // Colours come from the server's accents, one per harness, not from per-harness CSS.
  const dots = menu.locator(".harness-dot");
  const colours = await dots.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colours).size).toBe(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(row).toContainText("Fake B");
  await expect(row).toBeFocused();
  // Escape closes without changing anything.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toContainText("Fake B");
});

test("steer and follow-up while running, shown in the status stack", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow work");
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("then summarize");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await expect(page.getByTestId("queue-row").filter({ hasText: "then summarize" })).toBeVisible();
  await box.fill("focus on tests");
  await page.getByRole("button", { name: "Steer" }).click();
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  await expect(prompts(page)).toHaveText(["slow work", "focus on tests", "then summarize"]);
  await expect(page.getByTestId("queue-row")).toHaveCount(0);
});

test("stop shows Stopping, then settles with the turn marked stopped", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow and long");
  await expect(status(page)).toHaveText("Working");
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(status(page)).toHaveText(/Stopping|Idle/);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await expect(page.locator(".stopped-pill")).toHaveText("Stopped");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("an approval takes over the composer and is recorded in the turn", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for approval");
  await expect(card).toContainText("Allow tool: read");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText(["Stop", "Deny", "Approve"]);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await openFold(page);
  await expect(page.getByTestId("request-row")).toContainText("Approved");
  await expect(page.locator('[data-testid="tool-row"][data-status="done"]')).toHaveCount(1);
});

test("a question lists its options as numbered rows, and a number picks one", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "quiz please");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for your answer");
  await expect(card.locator(".approval-chip")).toHaveText("1 of 2");
  await expect(card.locator(".approval-headline")).toHaveText("Move both theme AND text size into config.yml?");
  await expect(card.locator(".choice-label")).toHaveText(["Both sharedRecommended", "Only text size shared, theme stays per-device", "Other (type your own)"]);
  await expect(card.locator(".choice.is-recommended")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("2");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("answer").last()).toContainText("Chose: Only text size shared, theme stays per-device");

  await send(page, "quiz described");
  await expect(card.locator(".approval-chip")).toHaveText("Settings");
  await expect(card.locator(".approval-headline")).toHaveText("Should the theme and the text size both move into config.yml?");
  await expect(card.locator(".choice-detail")).toHaveText(["Every device gets the same look.", "The theme stays per device.", "Keep both in each browser."]);
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
});

test("a prompt's actions show on hover: edit replaces it in place, retry branches where the harness cannot", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first idea");
  await sendAndWait(page, "second idea");
  const second = page.locator(".turn-prompt").nth(1);
  const actions = second.getByTestId("prompt-actions");
  await expect(actions).toHaveCSS("opacity", "0");
  await second.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await actions.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Edit message" });
  await expect(editor).toHaveValue("second idea");
  await expect(page.locator(".prompt-editor-note")).toHaveText("Replaces this message and everything after it");
  await editor.fill("a better second idea");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["first idea", "a better second idea"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: a better second idea", { timeout: 15_000 });
  await expect(page.getByTestId("turn")).toHaveCount(2);

  // Fake B cannot replace a message: Retry runs it again in a branch, and the original stays.
  await newChat(page, "Fake B");
  await sendAndWait(page, "only question");
  const first = page.locator(".turn-prompt").first();
  await first.hover();
  await first.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".banner")).toContainText("Branched from before message 1");
  await expect(page.getByTestId("answer").last()).toContainText("Echo: only question", { timeout: 15_000 });
});

test("reconnects after going offline without duplicating messages", async ({ page, context }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream");
  await expect(status(page)).toHaveText("Working");
  await context.setOffline(true);
  await expect(page.getByTestId("connection")).toHaveText("Disconnected");
  await expect(page.locator(".conn-banner")).toBeVisible();
  await page.waitForTimeout(800);
  await context.setOffline(false);
  await expect(page.getByTestId("connection")).toHaveText("Connected", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  await expect(prompts(page)).toHaveCount(1);
  await expect(answers(page)).toHaveCount(1);
  const text = await answers(page).first().innerText();
  expect(text.match(/Echo: slow stream/g)).toHaveLength(1);
});

test("a run keeps going after the browser closes, and another device can watch it finish", async ({ browser }) => {
  const laptop = await browser.newContext();
  const page = await laptop.newPage();
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow background run");
  await expect(status(page)).toHaveText("Working");
  // The browser goes away mid-run.
  await laptop.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await signInAndOpen(mobile);
  await showSidebar(mobile);
  await mobile.locator(".session", { hasText: "slow background run" }).first().click();
  await expect(prompts(mobile)).toHaveText(["slow background run"]);
  // It ran to the end on its own: the whole answer, not a "Stopped" one.
  await expect(answers(mobile).last()).toContainText("line 60", { timeout: 20_000 });
  await expect(status(mobile)).toHaveText("Idle", { timeout: 20_000 });
  await expect(mobile.getByText("Stopped")).toHaveCount(0);
  await phone.close();
});

test("reload re-attaches, and the session list resumes the same live chat", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "remember me");
  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(prompts(page)).toHaveText(["remember me"]);
  const row = page.locator(".session", { hasText: "remember me" });
  await expect(row).toBeVisible();
  await expect(row.locator(".live-dot")).toBeVisible();
  await row.click();
  await expect(prompts(page)).toHaveText(["remember me"]);
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Close chat" }).click();
  await expect(page.getByRole("heading", { name: "alpha", level: 2 })).toBeVisible();
  await page.locator(".session", { hasText: "remember me" }).click();
  await expect(prompts(page)).toHaveText(["remember me"]);
  await expect(answers(page)).toContainText("Echo: remember me");
});

test("model and thinking changes apply while idle", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await page.getByTestId("model-picker").click();
  await page.getByRole("combobox", { name: "Search models" }).fill("slow");
  await expect(page.getByRole("dialog", { name: "Choose a model" }).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
  // The effort slider: End goes to the strongest level, which applies once the knob settles.
  await page.getByTestId("thinking-picker").click();
  const effort = page.getByRole("slider", { name: "Thinking" });
  await expect(effort).toBeFocused();
  await page.keyboard.press("End");
  await expect(effort).toHaveAttribute("aria-valuetext", "high");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: high");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: high");
  await expect(page.getByTestId("connection")).toContainText("Connected");
  await expect(page.locator(".status-bar")).toContainText("Fake · Fake Slow · high");
  // A click on the track jumps to the nearest stop: the weakest, at its left end.
  await page.getByTestId("thinking-picker").click();
  const track = page.locator(".effort-track");
  const box = (await track.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(page.getByRole("slider", { name: "Thinking" })).toHaveAttribute("aria-valuetext", "off");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: off");
});

test("the model picker searches across providers, remembers recents, and works by keyboard", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  const picker = page.getByTestId("model-picker");
  await picker.click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toContainText("Current Fake Echo · fake");
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(dialog.getByRole("option", { name: /Fake Fresh/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Fake Echo/ }).locator(".model-tag")).toHaveText("high");
  // Grouped by provider, the current provider first.
  await expect(dialog.getByRole("group")).toHaveCount(3);
  await expect(dialog.getByRole("group").first()).toHaveAccessibleName("fake");
  // Punctuation-insensitive: "gpt55" finds GPT-5.5 and GPT-5.5 Mini.
  await search.fill("gpt55");
  await expect(dialog.getByRole("option")).toHaveText([/GPT-5\.5/, /GPT-5\.5 Mini/]);
  await expect(dialog.getByRole("option").first().locator(".model-tag")).toHaveText("xhigh");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("GPT-5.5 Mini");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(picker).toHaveAccessibleName("Model: GPT-5.5 Mini");
  await expect(picker).toBeFocused();
  // Recently used models show first next time (excluding the current one).
  await picker.click();
  await search.fill("glm flash");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Model: GLM-5.3-Flash");
  await picker.click();
  await expect(dialog.getByRole("group").first()).toHaveAccessibleName("Recent");
  await expect(dialog.getByRole("group").first().getByRole("option")).toHaveText([/GPT-5\.5 Mini/]);
  await search.fill("zzz");
  await expect(dialog).toContainText("No models match “zzz”");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Clicking outside closes it too.
  await picker.click();
  await page.locator(".chat-header").click({ position: { x: 20, y: 20 } });
  await expect(dialog).toBeHidden();
});

test("the model picker opens as a bottom sheet on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.getByTestId("model-picker").click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toBeInViewport();
  const box = (await dialog.boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(box.x).toBeLessThanOrEqual(9);
  expect(box.x + box.width).toBeGreaterThanOrEqual(381);
  await dialog.getByRole("option", { name: /GLM-5\.3-Flash/ }).click();
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: GLM-5.3-Flash");
});

test("markdown never renders raw HTML or unsafe links", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, 'x [bad](javascript:alert(1)) [ok](https://example.com) <img src=x onerror="window.pwned=1"> ![pic](https://example.com/p.png)');
  const md = answers(page).last().locator(".md");
  await expect(md.locator("a", { hasText: "ok" })).toHaveAttribute("href", "https://example.com");
  await expect(md.locator("a", { hasText: "bad" })).toHaveCount(0);
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.locator(".md-image")).toHaveText("[image: pic]");
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test("todos from the harness show in the status stack, which can be hidden", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "make a todo list");
  const stack = page.getByTestId("status-stack");
  await expect(stack).toContainText("Todos");
  await expect(stack).toContainText("1/3");
  await expect(stack.locator(".stack-row")).toHaveCount(3);
  await stack.getByRole("button", { name: "Hide status" }).click();
  await expect(stack.locator(".stack-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("status-stack").getByRole("button", { name: "Show status" })).toBeVisible();
});

test("context ring, edited files, and the turn rail", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // A fresh chat shows what fills the window, not zero-filled token and timing sections.
  await page.getByTestId("context-ring").click();
  await expect(page.getByRole("dialog", { name: "Context and usage" }).getByRole("region")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await sendAndWait(page, "please edit the app");
  await expect(page.getByTestId("changed-files")).toContainText("Changed 1 file");
  await expect(page.getByTestId("changed-files")).toContainText("src/app.ts");
  await expect(page.getByTestId("process-toggle").last()).toHaveText(/1 edit/);
  await expect(page.getByTestId("context-ring")).toBeVisible();
  await expect(page.getByTestId("context-ring")).toHaveAccessibleName(/% of context used · .* tokens/);
  // One panel: what fills the window, the session's tokens, and model timing.
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  await expect(panel.getByRole("region", { name: "Context" })).toContainText(/of context used/);
  await expect(panel).not.toContainText("~");
  await expect(panel.locator(".usage-label")).toContainText(["System prompt", "Tool definitions", "Messages", "Cache hit"]);
  await expect(panel.getByRole("region", { name: "Tokens" })).toContainText("Tokens this session");
  await expect(panel.getByRole("region", { name: "Session" })).toContainText(/1 turn · \d+ steps?/);
  await expect(panel.getByRole("region", { name: "Session" })).toContainText(/Tokens per second\s*\d+ tok\/s/);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await sendAndWait(page, "second turn");
  await sendAndWait(page, "third turn");
  const rail = page.getByRole("navigation", { name: "Jump to turn" });
  await expect(rail.getByRole("button")).toHaveCount(3);
  await rail.getByRole("button", { name: /Turn 1: please edit the app/ }).click();
  await expect(prompts(page).first()).toBeInViewport();
});

test("chat text size comes from config.yml, read-only without a settings folder", async ({ page }) => {
  await signInAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const slider = settings.getByRole("slider", { name: "Chat text size" });
  await expect(slider).toBeVisible();
  await expect(slider).toBeDisabled();
  await expect(settings.getByText("100%", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
});

test("the stylix theme file drives colors and passes contrast", async ({ page }) => {
  await signInAndOpen(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(29, 32, 33)");
  const ratio = await page.evaluate(() => {
    const parse = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = lum(parse(getComputedStyle(document.body).color));
    const back = lum(parse(getComputedStyle(document.body).backgroundColor));
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#1d2021");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`mobile ${viewport.width}px: drawer, composer, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAndOpen(page, "beta");
    // On phones the drawer stays open after picking a project so its sessions show.
    await expect(page.locator(".sidebar")).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await newChat(page);
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await expect(page.locator(".status-bar")).toBeHidden();
    await sendAndWait(page, "hello from the phone tool");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("navigation", { name: "Jump to turn" })).toBeHidden();
    await showSidebar(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toBeInViewport();
  });
}

test("several pending requests stack; answering the front one reveals the next", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask twice please");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("1 more");
  await expect(card).toHaveClass(/behind-1/);
  const first = (await card.locator(".approval-headline").innerText()).trim();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.locator(".approval-headline")).not.toHaveText(first);
  await expect(card).not.toContainText("more");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
});

test("the sidebar scopes sessions to the selected harness and opens them across projects", async ({ page }) => {
  await signInAndOpen(page, "beta");
  await newChat(page, "Fake B");
  await sendAndWait(page, "xproj one");
  for (const text of ["xproj two", "xproj three", "xproj four", "xproj five", "xproj six"]) {
    await newChat(page, "Fake");
    await sendAndWait(page, text);
  }
  // From another project, the selected harness's sessions are still listed under their own folder.
  await signInAndOpen(page, "alpha");
  await chooseHarness(page, "Fake");
  const groups = page.getByTestId("project-group");
  await expect(groups.first().locator(".project-name")).toHaveText("alpha");
  const beta = groups.filter({ has: page.locator(".project-name", { hasText: /^beta$/ }) });
  await expect(beta.locator(".session-title").first()).toHaveText("xproj six");
  await expect(beta.locator(".date-divider").first()).toHaveText("Today");

  // Only the Fake sessions: the Fake B one is another harness's, so it stays hidden.
  await expect(beta.locator(".session")).toHaveCount(4);
  await expect(beta.locator(".session", { hasText: "xproj one" })).toHaveCount(0);
  // Other projects show their newest few, then "Show N more".
  await beta.getByRole("button", { name: /^Show \d+ more in beta$/ }).click();
  await expect(beta.locator(".session")).toHaveCount(Number(await beta.locator(".group-count").innerText()));
  await expect(beta.locator(".session", { hasText: "xproj two" }).locator(".harness-dot")).toHaveAttribute("aria-label", "Fake");

  // Switching the harness swaps the list for that harness's own sessions.
  await chooseHarness(page, "Fake B");
  await expect(beta.locator(".session")).toHaveCount(1);
  await expect(beta.locator(".session", { hasText: "xproj one" }).locator(".harness-dot")).toHaveAttribute("aria-label", "Fake B");
  await expect(beta.locator(".session", { hasText: "xproj six" })).toHaveCount(0);

  // Search stays inside the selected harness.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("xproj six");
  await expect(page.getByText("No matching sessions")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("xproj one");
  await expect(page.locator(".session")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("no such session anywhere");
  await expect(page.getByText("No matching sessions")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Which sessions" })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("");

  // Opening a session from another project switches to that project.
  await chooseHarness(page, "Fake");
  await beta.locator(".session", { hasText: "xproj four" }).click();
  await expect(prompts(page)).toHaveText(["xproj four"]);
  await expect(page.locator(".workspace-name")).toHaveText("beta");
  await expect(groups.first().locator(".project-name")).toHaveText("beta");
});

test("a working session spins in the sidebar, also while another chat is open", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow spinner run");
  const row = page.locator(".session", { hasText: "slow spinner run" });
  await expect(row.getByRole("img", { name: "Working" })).toBeVisible();
  // Switch away: the run carries on in the background and spins until it settles.
  await newChat(page);
  await expect(row.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(row.getByRole("img", { name: "Working" })).toHaveCount(0, { timeout: 15_000 });
  await expect(row.locator(".live-dot")).toBeVisible();
});

test("/ opens the command menu: it filters, completes, runs, and closes", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  const box = page.getByRole("textbox", { name: "Message" });
  const menu = page.getByRole("listbox", { name: "Commands" });
  await box.fill("/");
  await expect(menu.getByRole("option")).toHaveText([/^\/new/, /^\/compact/, /^\/rename/, /^\/fake-status/, /^\/skill:review/]);
  // Typing filters; Enter completes the highlighted command, a second Enter runs it.
  await box.pressSequentially("fake");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await box.press("Enter");
  await expect(box).toHaveValue("/fake-status ");
  await expect(menu).toBeHidden();
  await box.press("Enter");
  await expect(prompts(page)).toHaveText(["/fake-status"]);
  await expect(page.getByText("fake status: all good")).toBeVisible();
  await expect(status(page)).toHaveText("Idle");
  // An app command, the same on every harness.
  await box.fill("/rename Better title");
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Better title");
  // Esc closes the menu and keeps the text.
  await box.fill("/re");
  await expect(menu).toBeVisible();
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await expect(box).toHaveValue("/re");
});

test("a finished turn forks into a new chat holding just that turn", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first question");
  await sendAndWait(page, "second question");
  await expect(prompts(page)).toHaveText(["first question", "second question"]);
  // The fork button lives on a finished answer; the copy opens in its place.
  await page.getByTestId("answer").first().getByRole("button", { name: "Fork from here" }).click();
  await expect(prompts(page)).toHaveText(["first question"]);
  await expect(status(page)).toHaveText("Idle");
  await expect(page.getByTestId("turn")).toHaveCount(1);
});

test("composer harness chip hands the chat off to another harness", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first tool question");
  await expect(prompts(page)).toHaveText(["first tool question"]);
  // The chip shows the current harness; its menu lists the others.
  await page.getByRole("button", { name: "Hand off to another harness" }).click();
  const targets = page.getByRole("listbox", { name: "Hand off to" });
  // The chat's own harness is listed but cannot be picked; a target says how it continues.
  await expect(targets.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(targets.getByRole("option", { name: "Fake B", exact: true })).toContainText("Copies the conversation");
  await targets.getByRole("option", { name: "Fake B", exact: true }).click();
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
  await expect(prompts(page)).toHaveText(["first tool question"]);
  await expect(status(page)).toHaveText("Idle");
  await expect(page.getByText(/Continued in .*model reset to default/)).toBeVisible();
});

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("images can be pasted, dropped, or picked, then removed or sent with the prompt", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  const box = page.getByRole("textbox", { name: "Message" });
  const strip = page.getByRole("list", { name: "Attached images" });
  const fire = (type: "paste" | "drop", selector: string) =>
    page.evaluate(
      ({ type, selector, b64 }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
        const target = document.querySelector(selector) as HTMLElement;
        if (type === "paste") target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        else for (const t of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      { type, selector, b64: PNG_1X1 },
    );

  // A screenshot on the clipboard, a dropped file, and one from the picker.
  await fire("paste", ".composer-input");
  await expect(strip.getByRole("img")).toHaveCount(1);
  // Each thumbnail carries its number and size, to refer to it by.
  await expect(strip.locator(".image-label strong")).toHaveText("#1");
  await expect(strip.locator(".image-label span")).toHaveText("1×1");
  await page.getByRole("button", { name: "View image #1" }).click();
  const viewer = page.getByRole("dialog", { name: "Image #1" });
  await expect(viewer.getByRole("img", { name: "Image #1, 1×1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await fire("drop", ".composer-card");
  await expect(strip.getByRole("img")).toHaveCount(2);
  await expect(strip.locator(".image-label strong")).toHaveText(["#1", "#2"]);
  // The viewer steps through them with the arrow keys.
  await page.getByRole("button", { name: "View image #1" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "Image #2" })).toContainText("2 of 2");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "c.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1, "base64") });
  await expect(strip.getByRole("img")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove image #3" }).click();
  await page.getByRole("button", { name: "Remove image #2" }).click();
  await expect(strip.getByRole("img")).toHaveCount(1);
  await expect(box).toHaveAttribute("placeholder", "Say what to do with the image…");

  // A text-only model is called out.
  const pick = async (query: string) => {
    await page.getByTestId("model-picker").click();
    await page.getByRole("combobox", { name: "Search models" }).fill(query);
    await page.keyboard.press("Enter");
  };
  await pick("glm");
  await expect(page.getByText(/GLM-5\.3-Flash does not take image input/)).toBeVisible();
  await pick("fake echo");
  await expect(page.getByText(/does not take image input/)).toHaveCount(0);

  // An image needs words to go with it; then both are sent.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await sendAndWait(page, "what is in this screenshot?");
  await expect(strip).toHaveCount(0);
  // The prompt keeps the picture itself, numbered, and it opens in the viewer.
  const sent = page.getByTestId("turn").last().getByRole("list", { name: "Images" });
  const loaded = (list: typeof sent) => list.getByRole("img", { name: "Image #1" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  await expect.poll(() => loaded(sent)).toBe(true);
  await expect(sent.locator(".image-label strong")).toHaveText("#1");
  await expect(sent.locator(".image-label span")).toHaveText("1×1");
  await sent.getByRole("button", { name: "View image #1" }).click();
  await expect(page.getByRole("dialog", { name: "Image #1" })).toContainText("1×1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // After a reload it comes back from the session.
  await page.reload();
  const again = page.getByTestId("turn").last().getByRole("list", { name: "Images" });
  await expect.poll(() => loaded(again)).toBe(true);
});

test("buttons show a Material ripple from the press point; reduced motion turns it off", async ({ page }) => {
  await signInAndOpen(page);
  const btn = page.getByRole("button", { name: "Refresh sessions" });
  const box = (await btn.boundingBox()) as { x: number; y: number; width: number; height: number };
  const px = box.x + 6;
  const py = box.y + box.height / 2;
  await page.mouse.move(px, py);
  await page.mouse.down();
  const ink = btn.locator(".ripple");
  await expect(ink).toHaveCount(1);
  const inkBox = (await ink.boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(Math.abs(inkBox.x + inkBox.width / 2 - px)).toBeLessThan(3);
  expect(Math.abs(inkBox.y + inkBox.height / 2 - py)).toBeLessThan(3);
  await expect(btn).toHaveAccessibleName("Refresh sessions");
  await page.mouse.up();
  await expect(ink).toHaveCount(0, { timeout: 3000 });
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(ink).toHaveCount(1);
  await expect(ink).toHaveCount(0, { timeout: 3000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.down();
  await page.mouse.up();
  await expect(ink).toHaveCount(0);
  expect(await btn.locator(".ripple").count()).toBe(0);
});

test("the sidebar collapses and expands from its header, and stays that way", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeFocused();
  const mainLeft = () => page.locator(".main").evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(mainLeft).toBeLessThan(2);
  await page.reload();
  await expect(page.locator(".chat-header")).toBeVisible();
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveCount(0);
  await expect.poll(mainLeft).toBeGreaterThan(200);
  // Phones keep the drawer: no collapse toggle there.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
});

test("narrow windows fold the sidebar away, and a sidebar collapsed by hand stays collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(sidebar).toBeVisible();
  // A vertical monitor or a tiled half screen.
  await page.setViewportSize({ width: 1080, height: 1800 });
  await expect(sidebar).toBeHidden();
  // Reopened by hand, it stays open in the narrow window, until the width crosses back and forth.
  await expand.click();
  await expect(sidebar).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(sidebar).toBeVisible();
  await page.setViewportSize({ width: 980, height: 1060 });
  await expect(sidebar).toBeHidden();
  // Collapsed with the button: resizing does nothing.
  await expand.click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(sidebar).toBeHidden();
  await page.setViewportSize({ width: 1080, height: 1800 });
  await expect(sidebar).toBeHidden();
});

test("the sidebar is resizable by drag and keyboard, and remembers its width", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = async () => (await sidebar.boundingBox())?.width ?? 0;
  expect(Math.round(await width())).toBe(272);
  const box = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(Math.round(await width())).toBe(392);
  await page.reload();
  expect(Math.round(await width())).toBe(392);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(Math.round(await width())).toBe(376);
  await page.keyboard.press("Home");
  expect(Math.round(await width())).toBe(200);
  // Dragging far past the limit clamps instead of swallowing the chat.
  const b2 = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(b2.x + 3, b2.y + 200);
  await page.mouse.down();
  await page.mouse.move(b2.x + 1200, b2.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round(await width())).toBe(560);
  await handle.dblclick();
  expect(Math.round(await width())).toBe(272);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
});

test("the model picker keeps its search and Current line intact when the list overflows", async ({ page }) => {
  // A short window forces the list to scroll inside the minimum-height popover.
  await page.setViewportSize({ width: 1360, height: 420 });
  await signInAndOpen(page);
  await newChat(page);
  await page.getByTestId("model-picker").click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toBeVisible();
  const clipped = await dialog.evaluate((el) => {
    const parts = [".model-search", ".model-current"].map((sel) => el.querySelector(sel) as HTMLElement);
    const list = el.querySelector(".model-list") as HTMLElement;
    return {
      parts: parts.map((p) => ({ clipped: p.scrollHeight > p.clientHeight + 1, height: p.getBoundingClientRect().height })),
      listScrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(clipped.listScrolls).toBe(true);
  for (const part of clipped.parts) {
    expect(part.clipped).toBe(false);
    expect(part.height).toBeGreaterThan(24);
  }
  await expect(dialog.locator(".model-current")).toBeInViewport({ ratio: 1 });
});

test("an extension's message (a memory recall) shows as a labelled row, not its raw envelope", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "recall what you know");
  await page.getByTestId("process-toggle").last().click();
  const row = page.getByTestId("extension-message").last();
  // Closed, it is just its label; the text is one click away, without the envelope.
  await expect(row).toHaveText("Memory");
  await expect(page.getByText("<memory>")).toHaveCount(0);
  await row.getByRole("button").first().click();
  await expect(row).toContainText("Your memory book: notes about the user.");
  await expect(row).toContainText("- prefers tabs over spaces");
});

test("subagents show live, then their answers, and open their own transcripts", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "run subagents please");
  // Seen working, the delegation is open: one agent running, the other queued.
  const row = page.locator('[data-testid="tool-row"][data-tool="subagent"]');
  await expect(row.locator(".run-status.is-running")).toHaveCount(1);
  await expect(row.locator(".run-activity")).toContainText("bash rg -n listen src");
  await expect(page.locator(".answer-actions")).toBeVisible({ timeout: 20000 });
  await openFold(page);
  // Settled, it opens like any other row.
  await row.getByRole("button").first().click();
  await expect(row.locator(".runs")).toBeVisible();
  await expect(row.locator(".drow-summary")).toHaveText("2 agents · 2 done");
  await expect(row.locator(".tool-card-meta")).toHaveText("2/2 done");
  await expect(row.locator(".run-agent")).toHaveText(["scout", "worker"]);
  await row.locator(".run-head").first().click();
  await expect(row.locator(".run-brief")).toContainText("Find where the server starts listening.");
  await expect(row.locator(".run-output")).toContainText("src/server.ts:13");
  await row.getByRole("button", { name: "Open transcript" }).click();
  const panel = page.getByRole("dialog", { name: "Transcript of 0" });
  await expect(panel.locator(".run-panel-brief")).toContainText("Task: Find where the server starts listening.");
  await expect(panel.getByTestId("tool-row")).toHaveAttribute("data-tool", "bash");
  await expect(panel.locator(".run-panel-text")).toContainText("calls listen(port, host)");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
