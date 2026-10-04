// Credential parity: what `npm run set-password` writes must be exactly what
// the server verifies — same username rule (config.ts) and same scrypt cost
// (auth.ts). If either side drifts, saved logins stop verifying; this pins both.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/server/auth.js";
import { USERNAME_PATTERN } from "../../src/server/config.js";

const require = createRequire(import.meta.url);
const script = require("../../scripts/set-password.mjs") as {
  PARAMS: { N: number; r: number; p: number; keylen: number };
  USERNAME_PATTERN: RegExp;
};

describe("set-password.mjs parity", () => {
  it("accepts exactly the usernames config.ts accepts", () => {
    expect(script.USERNAME_PATTERN.source).toBe(USERNAME_PATTERN.source);
    expect(script.USERNAME_PATTERN.flags).toBe(USERNAME_PATTERN.flags);
  });

  it("hashes with exactly auth.ts DEFAULTS", () => {
    expect(script.PARAMS).toEqual({ N: DEFAULTS.N, r: DEFAULTS.r, p: DEFAULTS.p, keylen: DEFAULTS.keylen });
  });
});
