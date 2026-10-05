import { expect, type Page } from "@playwright/test";

/**
 * Make the sidebar usable. On phones it is a drawer; `isVisible()` is not a
 * reliable signal mid-transition, so decide by layout and the drawer's state.
 */
export async function showSidebar(page: Page): Promise<void> {
  // Wait for the app shell; before bootstrap finishes neither layout exists yet.
  await expect(page.locator(".chat-header")).toBeVisible();
  const menu = page.getByRole("button", { name: "Open menu" });
  if (!(await menu.isVisible())) return;
  const sidebar = page.locator(".sidebar");
  if (!(await sidebar.evaluate((el) => el.classList.contains("is-open")))) await menu.click();
  await expect(sidebar).toBeInViewport({ ratio: 0.95 });
}

/** Open the app (this machine needs no sign-in) and pick a project through the folder browser. */
export async function signInAndOpen(page: Page, project = "alpha"): Promise<void> {
  await page.goto("/");
  await showSidebar(page);
  await page.locator(".workspace-btn").click();
  const dialog = page.getByRole("dialog", { name: "Choose a project folder" });
  await dialog.locator(".picker-scroll .picker-item").first().click();
  await dialog.getByRole("button", { name: project, exact: false }).click();
  await dialog.getByRole("button", { name: "Open this folder" }).click();
  await expect(dialog).toBeHidden();
}

/** Pick the sidebar's harness from its menu. */
export async function chooseHarness(page: Page, harness: string): Promise<void> {
  await page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: "Harness" }).click();
  await page.getByRole("listbox", { name: "Harness" }).getByRole("option", { name: harness, exact: true }).click();
}

export async function newChat(page: Page, harness?: string): Promise<void> {
  await showSidebar(page);
  if (harness) await chooseHarness(page, harness);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  // A fresh chat always opens as the hero; wait for it rather than for "Idle",
  // which the previous chat may already show.
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("connection")).toHaveText("Connected");
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** Send and wait until that turn's answer has finished (not just the "Idle" label). */
export async function sendAndWait(page: Page, text: string): Promise<void> {
  const turns = page.getByTestId("turn");
  const before = await turns.count();
  await send(page, text);
  await expect(turns).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(turns.last().getByTestId("answer")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
}
