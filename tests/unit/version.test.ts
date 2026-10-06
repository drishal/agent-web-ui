import { describe, expect, it } from "vitest";
import { versionLabel } from "../../src/server/harness/version.js";

describe("harness version labels", () => {
  it("keeps plain versions as they are, without a leading v", () => {
    expect(versionLabel("1.0.2\n")).toEqual({ version: "1.0.2" });
    expect(versionLabel("v1.0.2")).toEqual({ version: "1.0.2", versionDetail: "v1.0.2" });
    expect(versionLabel("18.6.1")).toEqual({ version: "18.6.1" });
  });

  it("shortens a line that says more, keeping it as the detail", () => {
    expect(versionLabel("2.1.290 (Claude Code)")).toEqual({ version: "2.1.290", versionDetail: "2.1.290 (Claude Code)" });
  });

  it("uses the release date when the version is a placeholder (Hermes on Nix)", () => {
    expect(versionLabel("v0.0.0 (2026.9.24) · upstream 73da8e6b\nInstall directory: /nix/store/x")).toEqual({
      version: "2026.9.24",
      versionDetail: "v0.0.0 (2026.9.24) · upstream 73da8e6b",
    });
    // A real release keeps its number; the date is only a stand-in.
    expect(versionLabel("v0.13.2 (2026.9.24) · upstream 73da8e6b").version).toBe("0.13.2");
    // A placeholder with no date stays what it is.
    expect(versionLabel("v0.0.0").version).toBe("0.0.0");
  });

  it("shows output it cannot read as is", () => {
    expect(versionLabel("nightly build")).toEqual({ version: "nightly build" });
  });
});
