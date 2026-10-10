import { describe, expect, it } from "vitest";
import { builtBinaryPath, selfToInstall } from "../../src/server/install-service.js";

describe("install service picks the file to put on the PATH", () => {
  it("installs itself as the binary, without looking for a checkout", () => {
    const self = selfToInstall("/home/me/.local/bin/awui", true, () => {
      throw new Error("the binary must not look for a built copy");
    });
    expect(self).toBe("/home/me/.local/bin/awui");
  });

  it("installs the built binary when the process is node, as bin/awui runs it", () => {
    // Any existing file stands in for the built binary; the check is existence.
    const built = import.meta.filename;
    expect(selfToInstall("/nix/store/xxx-nodejs-slim-22.23.3/bin/node", false, () => built)).toBe(built);
  });

  it("says what to build when no binary exists yet", () => {
    const call = () => selfToInstall("/usr/bin/node", false, () => "/checkout/dist/bin/linux-x64/awui");
    expect(call).toThrow(/build-binary\.ts/);
    try {
      call();
    } catch (error) {
      // A plain Error would exit as a crash; this one is reported, then exits 1.
      expect(error).toMatchObject({ status: 500, code: "no_binary" });
    }
  });

  it("names the binary where scripts/build-binary.ts writes it", () => {
    expect(builtBinaryPath("/checkout", "linux", "x64")).toBe("/checkout/dist/bin/linux-x64/awui");
    expect(builtBinaryPath("/checkout", "darwin", "arm64")).toBe("/checkout/dist/bin/darwin-arm64/awui");
    expect(builtBinaryPath("/checkout", "win32", "x64")).toBe("/checkout/dist/bin/win32-x64/awui.exe");
  });
});
