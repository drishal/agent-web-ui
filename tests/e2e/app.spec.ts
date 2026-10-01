import { expect, test } from "@playwright/test";
import { newChat, send, signInAndOpen, token } from "./helpers.js";

const status = (page: import("@playwright/test").Page) => page.getByTestId("chat-status");

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

test("open a project, chat, and see streamed thinking, markdown, and a tool row", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await expect(page.getByText("Tools start read-only")).toBeVisible();
  await send(page, "hello tool **bold**");
  await expect(status(page)).toHaveText("Working");
  await expect(page.locator(".tool .tool-name", { hasText: "read" })).toBeVisible();
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  const reply = page.locator(".msg-assistant").last();
  await expect(reply.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(reply.locator(".thinking summary")).toHaveText(/Thinking/);
  await expect(page.locator(".tool-done")).toHaveCount(1);
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
  await expect(page.locator(".msg-assistant").last()).toContainText("Echo: change of plan", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  // Switching back: the open chat stays on Fake B; new chats use Fake.
  await page.getByRole("radio", { name: "Fake", exact: true }).click();
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
});

test("steer and follow-up while running, with a visible queue", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow work");
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("then summarize");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await expect(page.locator(".queue-chip", { hasText: "then summarize" })).toBeVisible();
  await box.fill("focus on tests");
  await page.getByRole("button", { name: "Steer" }).click();
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  const users = page.locator(".msg-user .msg-user-text");
  await expect(users).toHaveText(["slow work", "focus on tests", "then summarize"]);
  await expect(page.locator(".queue-chip")).toHaveCount(0);
});

test("stop shows Stopping, then settles with the turn marked stopped", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow and long");
  await expect(status(page)).toHaveText("Working");
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(status(page)).toHaveText(/Stopping|Idle/);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await expect(page.locator(".msg-error.is-stopped")).toHaveText("Stopped");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("an approval request takes over the composer and is recorded", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.locator(".request-card");
  await expect(card).toContainText("Allow tool: read");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".request-record")).toContainText("Approved");
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await expect(page.locator(".tool-done")).toHaveCount(1);
});

test("reconnects after going offline without duplicating messages", async ({ page, context }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream");
  await expect(status(page)).toHaveText("Working");
  await context.setOffline(true);
  await expect(page.getByTestId("connection")).toHaveText("Disconnected");
  await page.waitForTimeout(800);
  await context.setOffline(false);
  await expect(page.getByTestId("connection")).toHaveText("Connected", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.locator(".msg-user")).toHaveCount(1);
  await expect(page.locator(".msg-assistant")).toHaveCount(1);
  const text = await page.locator(".msg-assistant .md").innerText();
  expect(text.match(/Echo: slow stream/g)).toHaveLength(1);
});

test("reload re-attaches, and the session list resumes the same live chat", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "remember me");
  // Wait for the finished reply, not just "Idle" (which shows until the first event).
  await expect(page.locator(".msg-assistant .md")).toContainText("Echo: remember me", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(page.locator(".msg-user .msg-user-text")).toHaveText(["remember me"]);
  const row = page.locator(".session", { hasText: "remember me" });
  await expect(row).toBeVisible();
  await expect(row.locator(".live-dot")).toBeVisible();
  await row.click();
  await expect(page.locator(".msg-user .msg-user-text")).toHaveText(["remember me"]);
  // Close it, then resume: rebuilt from the harness's own history.
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Close chat" }).click();
  await expect(page.getByRole("heading", { name: "alpha", level: 2 })).toBeVisible();
  await page.locator(".session", { hasText: "remember me" }).click();
  await expect(page.locator(".msg-user .msg-user-text")).toHaveText(["remember me"]);
  await expect(page.locator(".msg-assistant")).toContainText("Echo: remember me");
});

test("full tools need an explicit confirmation", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Enable full tools?" });
  await expect(dialog).toContainText("as you");
  await dialog.getByRole("button", { name: "Keep read-only" }).click();
  await expect(page.getByRole("button", { name: "Read-only" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await page.getByRole("dialog", { name: "Enable full tools?" }).getByRole("button", { name: "Enable full tools" }).click();
  await expect(page.getByRole("button", { name: "Full", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".notice-warning", { hasText: "Full tools enabled" })).toBeVisible();
});

test("model and thinking changes apply while idle", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("combobox", { name: "Model" }).selectOption("fake/slow");
  await page.getByRole("combobox", { name: "Thinking" }).selectOption("high");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("fake/slow");
  await expect(page.getByRole("combobox", { name: "Thinking" })).toHaveValue("high");
});

test("markdown never renders raw HTML or unsafe links", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, 'x [bad](javascript:alert(1)) [ok](https://example.com) <img src=x onerror="window.pwned=1"> ![pic](https://example.com/p.png)');
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  const md = page.locator(".msg-assistant .md").last();
  await expect(md.locator("a", { hasText: "ok" })).toHaveAttribute("href", "https://example.com");
  await expect(md.locator("a", { hasText: "bad" })).toHaveCount(0);
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.locator(".md-image")).toHaveText("[image: pic]");
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
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
    await send(page, "hello from the phone");
    await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
    await expect(page.getByRole("textbox", { name: "Message" })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator(".sidebar")).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toBeInViewport();
  });
}
