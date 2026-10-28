import { expect, type Page, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

/** Open a finished turn's "Worked for …" fold. */
async function openFold(page: Page) {
  const toggle = page.getByTestId("process-toggle").last();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("an MCP-like call shows its arguments and its JSON result as folding trees", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await openFold(page);
  const row = page.locator('[data-testid="tool-row"][data-tool="mcp__tracker__triage_ticket"]');
  await row.getByRole("button").first().click();
  const input = row.getByRole("tree", { name: "Input as JSON" });
  await expect(input.getByText("labels", { exact: true })).toBeVisible();
  await expect(input.locator(".tk-key", { hasText: "filter" })).toBeVisible();
  const output = row.getByRole("tree", { name: "Output as JSON" });
  // Two levels are open: the items array lists its objects, still folded, so no title shows yet.
  const items = output.getByRole("button", { name: "items, [2]" });
  await expect(output.getByRole("button", { name: "0, {4}" })).toBeVisible();
  await expect(output.getByText('"Listen ignores the host"')).toHaveCount(0);
  await output.getByRole("button", { name: "0, {4}" }).click();
  await expect(output.getByText('"Listen ignores the host"')).toBeVisible();
  // A fold toggles: the items array closes and its rows go.
  await items.click();
  await expect(output.getByRole("button", { name: "0, {4}" })).toHaveCount(0);
  await items.click();
  await expect(output.getByRole("button", { name: "0, {4}" })).toBeVisible();
  // The raw text stays reachable: Copy hands back the JSON, not the drawn tree.
  await expect(output.getByRole("button", { name: /Copy JSON/ })).toBeAttached();
});
