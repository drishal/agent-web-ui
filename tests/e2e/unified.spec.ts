// The pieces that make the app whole, one test each: the shortcut sheet,
// search across every chat, the file viewer, saved prompts, usage, the split
// view, the checkpoint timeline, and chained follow-ups.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("? opens the keyboard shortcuts, which a word narrows, and Escape closes them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // In the composer, ? is a character…
  await box(page).fill("why?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  // …outside it, the sheet.
  await page.getByRole("heading", { name: /^What should/ }).click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Composer" })).toContainText("Stash the draft for later");
  await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("stash");
  await expect(sheet.locator(".keys-row")).toHaveCount(1);
  await expect(sheet.locator(".keys-row .keycap")).toHaveText(["Alt", "S"]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Ctrl+/ works from inside the composer too.
  await box(page).focus();
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
});

test("$ lists the harness's skills, which leave the / menu, and Tab puts one in", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await box(page).fill("/");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands.getByRole("option", { name: /fake-status/ })).toBeVisible();
  await expect(commands.getByRole("option", { name: /skill:review/ })).toHaveCount(0);
  await expect(commands).toContainText("1 skill under $");
  await box(page).fill("$rev");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills.getByRole("option")).toHaveText([/\$review\s*Review the work so far/]);
  await page.keyboard.press("Tab");
  await expect(box(page)).toHaveValue("/skill:review ");
  // A $ further in is only a character.
  await box(page).fill("costs $5");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
});

test("Search every chat finds what a chat said, and opens it with the word found", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the quokka migration plan");
  await newChat(page);
  await sendAndWait(page, "nothing to see here");
  // From the sidebar's search: its words, looked for in what the chats said.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("quokka");
  await page.getByRole("button", { name: /Search every chat for/ }).click();
  const dialog = page.getByRole("dialog", { name: "Search every chat" });
  const found = dialog.getByRole("listbox", { name: "Chats found" }).getByRole("option");
  await expect(found).toHaveCount(1);
  await expect(found.first()).toContainText("the quokka migration plan");
  await expect(found.first().locator("mark").first()).toHaveText("quokka");
  // Every word must be in one message; the harness chips narrow it.
  await dialog.getByRole("searchbox", { name: "Search every chat" }).fill("quokka nothing");
  await expect(dialog.getByRole("status")).toContainText("Nothing found");
  await dialog.getByRole("searchbox", { name: "Search every chat" }).fill("quokka plan");
  await expect(found).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the quokka migration plan");
  await expect(page.getByRole("searchbox", { name: "Find in chat" })).toHaveValue("quokka");
  await expect(page.getByTestId("find-count")).toContainText(/of [1-9]/);
  // Ctrl+Shift+H opens it anywhere.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+H");
  await expect(dialog).toBeVisible();
});

test("a changed file opens in the viewer, coloured, its added lines marked, and a line goes into the message", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "beta");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "app.ts"), "// the app\nconst b = 1;\nexport default b;\n");
  await signInAndOpen(page, "beta");
  await newChat(page);
  await sendAndWait(page, "edit please");
  const turn = page.getByTestId("turn").last();
  await turn.getByTestId("changed-files").getByRole("button").first().click();
  await turn.getByTestId("changed-files").getByRole("button", { name: "src/app.ts", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "File src/app.ts" });
  await expect(viewer).toBeVisible();
  const code = viewer.getByRole("region", { name: "Contents of src/app.ts" });
  await expect(code).toContainText("export default b;");
  await expect(code.locator(".tk-keyword").first()).toHaveText("const");
  await expect(code.locator(".tk-comment")).toHaveText("// the app");
  await expect(viewer).toContainText("Changed in this chat");
  await expect(viewer).toContainText("3 lines");
  // A line's number marks it; Mention puts it into the message.
  await viewer.getByRole("button", { name: "Line 2", exact: true }).click();
  await viewer.getByRole("button", { name: "Mention line 2" }).click();
  await expect(viewer).toBeHidden();
  await expect(box(page)).toHaveValue("@src/app.ts:2");
  // The palette's Open a file: Go to file finds one by name; what git would not list is refused.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("open a file");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Open a file" });
  await picker.getByRole("searchbox", { name: "Go to file" }).fill("app");
  await picker.getByRole("listbox", { name: "Files" }).getByRole("option").first().click();
  await expect(page.getByRole("dialog", { name: "File src/app.ts" })).toBeVisible();
});

test("a saved prompt goes in with # and its blanks are filled in with Tab; any device sees it", async ({ page, browser }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Saved from a draft, through the stash menu.
  await box(page).fill("Review {{file}} for {{risk}}");
  await page.getByRole("button", { name: /^Stash/ }).click();
  await page.getByRole("menuitem", { name: "Save the draft as a prompt…" }).click();
  const manager = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(manager.getByRole("textbox", { name: "Prompt" })).toHaveValue("Review {{file}} for {{risk}}");
  await expect(manager.locator(".blank-chip")).toHaveText(["file", "risk"]);
  await manager.getByRole("textbox", { name: "Name" }).fill("risky");
  await manager.getByRole("button", { name: "Save prompt" }).click();
  await expect(manager.getByRole("list", { name: "Your saved prompts" })).toContainText("#risky");
  await page.keyboard.press("Escape");
  await expect(manager).toBeHidden();
  // # puts it in, the first blank selected: typing fills it, Tab goes to the next.
  await box(page).fill("#ris");
  await expect(page.getByRole("listbox", { name: "Saved prompts" }).getByRole("option")).toHaveText([/#risky\s*Review ‹file› for ‹risk›/]);
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveValue("Review {{file}} for {{risk}}");
  await page.keyboard.type("app.ts");
  await page.keyboard.press("Tab");
  await page.keyboard.type("races");
  await expect(box(page)).toHaveValue("Review app.ts for races");
  // Another browser (another device) has it too.
  const other = await browser.newPage();
  await signInAndOpen(other);
  await newChat(other);
  await other.getByRole("textbox", { name: "Message" }).fill("#");
  await expect(other.getByRole("listbox", { name: "Saved prompts" })).toContainText("#risky");
  await other.close();
});

test("Usage across chats adds up the calls by day, harness, and model, and opens a chat that used much", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "spend some tokens on the usage report");
  await page.getByRole("button", { name: "Usage across chats" }).click();
  const usage = page.getByRole("dialog", { name: "Usage" });
  await expect(usage.locator(".usage-card").first()).toContainText(/Tokens\s*[\d.]+k?/);
  await expect(usage.getByRole("region", { name: "Tokens by day" }).locator(".usage-day")).toHaveCount(30);
  await usage.getByRole("button", { name: "7 days" }).click();
  await expect(usage.getByRole("region", { name: "Tokens by day" }).locator(".usage-day")).toHaveCount(7);
  await expect(usage.getByRole("region", { name: "By harness" })).toContainText("Fake");
  await expect(usage.getByRole("region", { name: "By model" })).toContainText("echo");
  await expect(usage.locator(".usage-card", { hasText: "Cost" })).toContainText("$");
  // The chat that used the most (whichever it is, with the other tests' chats about) opens on a click.
  const top = usage.getByRole("region", { name: "Chats that used the most" }).getByRole("button").first();
  const title = (await top.locator(".usage-chat-title").textContent()) ?? "";
  await top.click();
  await expect(usage).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});

test("a chat opens beside the main one, streams and takes messages there, and swaps with Make main", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the left one");
  await newChat(page);
  await sendAndWait(page, "the right one");
  await page.getByRole("button", { name: "Open a chat beside", exact: true }).click();
  const side = page.getByRole("region", { name: "Chat beside" });
  // The shown chat cannot open beside itself.
  await expect(side.getByRole("button", { name: /the right one/ })).toBeDisabled();
  await side.getByRole("button", { name: /the left one/ }).click();
  await expect(side.getByRole("heading", { level: 2 })).toHaveText("the left one");
  await side.getByRole("textbox", { name: "Message" }).fill("slow reply beside");
  await side.getByRole("button", { name: "Send", exact: true }).click();
  await expect(side.getByTestId("side-status")).toHaveText("Working");
  await expect(side.getByTestId("turn")).toHaveCount(2);
  await expect(side.getByTestId("side-status")).toHaveText("Idle", { timeout: 20_000 });
  // The main chat did not move, and its URL still names it.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the right one");
  const hash = await page.evaluate(() => location.hash);
  await side.getByRole("button", { name: "Make main" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the left one");
  await expect(side.getByRole("heading", { level: 2 })).toHaveText("the right one");
  expect(await page.evaluate(() => location.hash)).not.toBe(hash);
  await side.getByRole("button", { name: "Close the chat beside" }).click();
  await expect(side).toHaveCount(0);
});

test("the file timeline compares any two points of a chat's checkpoints, and offers to undo to one", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "timeline-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "app.ts"), "const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  await signInAndOpen(page, "timeline-repo");
  await newChat(page);
  await sendAndWait(page, "first step");
  writeFileSync(path.join(project, "app.ts"), "const a = 2;\nconst b = 3;\n");
  await sendAndWait(page, "second step");
  writeFileSync(path.join(project, "notes.md"), "# notes\n");
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "File timeline" }).click();
  const timeline = page.getByRole("dialog", { name: "File timeline" });
  const rail = timeline.getByRole("navigation", { name: "Points" });
  await expect(rail.getByRole("button")).toHaveText(["#1", "#2", "Now"]);
  // At first: from before the first prompt to now, every file the chat saw change.
  await expect(timeline.getByTestId("timeline-file")).toHaveCount(2);
  await expect(timeline.getByTestId("timeline-file").first()).toContainText("app.ts");
  await expect(timeline.getByTestId("timeline-file").first()).toContainText("const b = 3;");
  await rail.getByRole("button", { name: /Before prompt 2/ }).click();
  await expect(timeline.getByTestId("timeline-file")).toHaveCount(1);
  await expect(timeline.getByTestId("timeline-file")).toContainText("notes.md");
  await expect(timeline.getByTestId("timeline-file")).toContainText("added");
  await timeline.getByRole("button", { name: "Undo to before #2…" }).click();
  await expect(timeline).toBeHidden();
  await expect(page.getByRole("dialog").filter({ hasText: "notes.md" })).toBeVisible();
});
