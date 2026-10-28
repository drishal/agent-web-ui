import { describe, expect, it } from "vitest";
import { foldRequest } from "../../src/web/approval-fold.js";
import type { InteractionRequest } from "../../src/shared/protocol.js";

const confirm = { id: "r1", kind: "confirm", title: "Allow tool: read\nfile.txt" } as InteractionRequest;

describe("foldRequest", () => {
  it("names an approval by its first line", () => {
    expect(foldRequest(confirm, { kind: "confirm", confirmed: true })).toEqual({ id: "r1", text: "Approved: Allow tool: read", ok: true });
  });
  it("marks a denial and a dismissal as not ok", () => {
    expect(foldRequest(confirm, { kind: "confirm", confirmed: false })).toMatchObject({ text: "Denied: Allow tool: read", ok: false });
    expect(foldRequest(confirm, { kind: "cancel" })).toMatchObject({ text: "Dismissed: Allow tool: read", ok: false });
  });
  it("reads a select's Approve and Deny as such, and any other choice by name", () => {
    const sel = { id: "r2", kind: "select", title: "Run it?", options: ["Approve", "Deny"] } as InteractionRequest;
    expect(foldRequest(sel, { kind: "select", value: "Deny" })).toMatchObject({ text: "Denied: Run it?", ok: false });
    expect(foldRequest(sel, { kind: "select", value: "Approve" })).toMatchObject({ ok: true });
    expect(foldRequest(sel, { kind: "select", value: "Blue" }).text).toBe("Chose “Blue”: Run it?");
  });
});
