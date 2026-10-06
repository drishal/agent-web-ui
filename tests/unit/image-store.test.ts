import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { historyToItems } from "../../src/server/harness/agent-events.js";
import { transcriptMessages } from "../../src/server/harness/claude-sessions.js";
import { imageRefs, rememberImage, storedImage } from "../../src/server/image-store.js";
import { makeTestApp, type TestApp } from "../helpers/app.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("image store", () => {
  it("keeps prompt images by the hash of their bytes, raster types only", () => {
    const ref = rememberImage("image/png", PNG);
    expect(ref?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(rememberImage("image/png", PNG)).toEqual(ref);
    expect(storedImage(ref?.id as string)?.bytes.toString("base64")).toBe(PNG);
    // An SVG from this origin could run script; an empty block is no image.
    expect(rememberImage("image/svg+xml", PNG)).toBeNull();
    expect(imageRefs([{ type: "text", text: "x" }, { type: "image", data: "", mimeType: "image/png" }])).toEqual([]);
  });

  it("puts history images on their prompt, from Pi's blocks and Claude Code's", () => {
    const pi = historyToItems([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }] }]);
    expect(pi[0]).toMatchObject({ kind: "user", imageCount: 1, images: [{ mimeType: "image/png" }] });
    const claude = historyToItems(
      transcriptMessages([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "s",
          timestamp: "2026-10-01T00:00:00Z",
          message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
        },
      ]),
    );
    expect(claude[0]).toMatchObject({ kind: "user", imageCount: 1, images: [{ id: (pi[0] as { images: Array<{ id: string }> }).images[0]?.id }] });
  });

  it("serves them to signed-in devices only", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: ["192.168.1.50"] });
    const ref = rememberImage("image/png", PNG) as { id: string };
    const local = await request(t.server).get(`/api/images/${ref.id}`);
    expect(local.status).toBe(200);
    expect(local.headers["content-type"]).toBe("image/png");
    expect(local.headers["x-content-type-options"]).toBe("nosniff");
    expect((await request(t.server).get(`/api/images/${"0".repeat(32)}`)).status).toBe(404);
    expect((await request(t.server).get(`/api/images/${ref.id}`).set("Host", `192.168.1.50:${t.port}`)).status).toBe(401);
  });
});
