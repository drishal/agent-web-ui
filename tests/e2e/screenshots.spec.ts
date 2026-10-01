import { expect, test } from "@playwright/test";
import { newChat, send, signInAndOpen } from "./helpers.js";

// Visual check only: AWUI_SCREENSHOTS=<dir> npx playwright test screenshots
const dir = process.env.AWUI_SCREENSHOTS;
test.skip(!dir, "set AWUI_SCREENSHOTS to a directory to capture screenshots");

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
  ["narrow", { width: 320, height: 640 }],
] as const) {
  test(`capture ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAndOpen(page);
    await page.screenshot({ path: `${dir}/${name}-0-empty.png` });
    await newChat(page);
    await send(page, "hello tool, render **markdown** and a `code` span");
    await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
    await page.locator(".thinking summary").first().click();
    await page.locator(".tool summary").first().click();
    await page.screenshot({ path: `${dir}/${name}-1-chat.png` });
    await send(page, "ask please");
    await expect(page.locator(".request-card")).toBeVisible();
    await page.screenshot({ path: `${dir}/${name}-2-approval.png` });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
    if (name !== "desktop") {
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.locator(".sidebar")).toBeInViewport({ ratio: 0.95 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${dir}/${name}-3-drawer.png` });
    }
  });
}
