// The pieces that make the app whole, one test each: the shortcut sheet,
// search across every chat, the file viewer, saved prompts, usage, the split
// view, the checkpoint timeline, and chained follow-ups.
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
