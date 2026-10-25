import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { showSidebar, signInAndOpen } from "./helpers.js";

// The e2e server asks a stand-in herdr (global-setup.ts) whose panes are agents.json.
const herdrDir = () => process.env.AWUI_E2E_HERDR as string;
const setPanes = (agents: unknown[]) => writeFileSync(path.join(herdrDir(), "agents.json"), JSON.stringify(agents));
const asked = (): Array<{ method: string; params: Record<string, unknown> }> => {
  try {
    return readFileSync(path.join(herdrDir(), "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  } catch {
    return [];
  }
};

test("a session open in a herdr pane is marked, shown in herdr, or opened here only when asked", async ({ page }) => {
  // A finished session that this server no longer holds, made through the API so no tab of this page keeps it.
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await page.request.post("/api/workspaces/open", { data: { path: path.join(root, "beta") } })).json()) as { id: string };
  const chat = (await (await page.request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as ChatSnapshot;
  await page.request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: "herdr pane session" } });
  let sessionId: string | null = null;
  await expect
    .poll(async () => {
      const now = (await (await page.request.get(`/api/chats/${chat.chatId}`)).json()) as ChatSnapshot;
      sessionId = now.sessionId;
      return now.status === "idle" && now.items.some((i) => i.kind === "assistant");
    })
    .toBe(true);
  await page.request.post(`/api/chats/${chat.chatId}/dispose`);
  const nativeId = (sessionId as unknown as string).slice("fake:".length);
  setPanes([{ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent: "fake", agent_status: "working", agent_session: { kind: "id", value: nativeId, source: "herdr:fake" } }]);
  try {
    await signInAndOpen(page, "beta");
    await showSidebar(page);
    const row = page.locator(".session", { hasText: "herdr pane session" });
    await expect(row.locator(".session-herdr")).toHaveAttribute("aria-label", /Open in herdr, pane w1:p2 \(working\)/);
    await expect(row.locator(".session-herdr")).toHaveClass(/is-working/);

    await row.click();
    const dialog = page.getByRole("dialog", { name: "Open in herdr" });
    await expect(dialog).toContainText("pane w1:p2 (working)");
    await dialog.getByRole("button", { name: "Show in herdr" }).click();
    await expect(dialog).toBeHidden();
    expect(asked()).toContainEqual({ method: "agent.focus", params: { target: "w1:p2" } });
    // Nothing opened here.
    await expect(page.getByTestId("user-prompt")).toHaveCount(0);

    await row.click();
    await dialog.getByRole("button", { name: "Open here anyway" }).click();
    await expect(page.getByTestId("user-prompt")).toHaveText(["herdr pane session"]);
  } finally {
    setPanes([]);
  }
});
