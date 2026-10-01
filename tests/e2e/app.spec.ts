import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen, token } from "./helpers.js";

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

test("an unsigned browser gets the sign-in message, not the app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This browser is not signed in" })).toBeVisible();
  const res = await page.request.get("/api/bootstrap");
  expect(res.status()).toBe(401);
});

test("the token link signs in and the URL is cleaned", async ({ page }) => {
  await page.goto(`/?token=${token()}`);
  await expect(page).toHaveURL(/\/$/);
  expect(page.url()).not.toContain("token");
  await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
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
  await expect(row.locator(".io-card")).toContainText("# Fake README");
  await expect(page.getByTestId("thought-row").last()).toContainText("Thought");
  await expect(page.getByRole("button", { name: "Copy reply" }).last()).toBeVisible();
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
  await page.getByRole("radio", { name: "Fake", exact: true }).click();
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
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
  await page.getByRole("combobox", { name: "Model" }).selectOption("fake/slow");
  await page.getByRole("combobox", { name: "Thinking" }).selectOption("high");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("fake/slow");
  await expect(page.getByRole("combobox", { name: "Thinking" })).toHaveValue("high");
  await expect(page.getByTestId("connection")).toContainText("Connected");
  await expect(page.locator(".status-bar")).toContainText("Fake · Fake Slow · high");
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
  await sendAndWait(page, "please edit the app");
  await expect(page.getByTestId("changed-files")).toContainText("Changed 1 file");
  await expect(page.getByTestId("changed-files")).toContainText("src/app.ts");
  await expect(page.getByTestId("process-toggle").last()).toHaveText(/1 edit/);
  await expect(page.getByTestId("context-ring")).toBeVisible();
  await expect(page.getByTestId("context-ring")).toHaveAccessibleName(/% of context used · .* tokens/);
  await sendAndWait(page, "second turn");
  await sendAndWait(page, "third turn");
  const rail = page.getByRole("navigation", { name: "Jump to turn" });
  await expect(rail.getByRole("button")).toHaveCount(3);
  await rail.getByRole("button", { name: /Turn 1: please edit the app/ }).click();
  await expect(prompts(page).first()).toBeInViewport();
});

test("chat text size scales the conversation only", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "size check");
  const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="user-prompt"]') as Element).fontSize));
  const sidebarSize = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".session-title") as Element).fontSize));
  const before = await size();
  const sidebarBefore = await sidebarSize();
  await page.getByRole("combobox", { name: "Chat text size" }).selectOption({ label: "Larger" });
  await expect.poll(size).toBeGreaterThan(before * 1.15);
  expect(await sidebarSize()).toBe(sidebarBefore);
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
  await page.getByRole("combobox", { name: "Theme" }).selectOption("light");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
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

test("the All view groups sessions by harness with counts", async ({ page }) => {
  await signInAndOpen(page, "beta");
  await newChat(page, "Fake B");
  await sendAndWait(page, "from b");
  await newChat(page, "Fake");
  await sendAndWait(page, "from a");
  await page.getByRole("radio", { name: "All" }).click();
  const groups = page.locator(".session-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.locator(".group-head")).toHaveText([/Fake\s*\d+/, /Fake B\s*\d+/]);
  await page.getByRole("radio", { name: "Fake", exact: true }).nth(1).click();
  await expect(page.locator(".date-divider").first()).toHaveText(/Today|Open/);
});
