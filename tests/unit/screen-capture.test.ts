// Capturing a window into the composer (screen-capture.ts): where the button may
// be offered, and how a refused or cancelled capture reads. The frame grab
// itself needs a real MediaStream, so it is covered by the e2e spec.
import { describe, expect, it } from "vitest";
import { captureFailure, screenCaptureAvailable } from "../../src/web/screen-capture.js";

describe("capturing the screen", () => {
  it("is offered only where getDisplayMedia is a function", () => {
    expect(screenCaptureAvailable({ getDisplayMedia: () => undefined })).toBe(true);
    expect(screenCaptureAvailable({ getDisplayMedia: "yes" })).toBe(false);
    expect(screenCaptureAvailable({})).toBe(false);
    expect(screenCaptureAvailable(undefined)).toBe(false);
    expect(screenCaptureAvailable(null)).toBe(false);
  });

  it("says nothing when the picker was closed, one line when it failed", () => {
    expect(captureFailure({ name: "NotAllowedError" })).toBeNull();
    expect(captureFailure({ name: "AbortError" })).toBeNull();
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    expect(captureFailure(denied)).toBeNull();
    expect(captureFailure({ name: "NotFoundError" })).toBe("No window was available to capture");
    expect(captureFailure(new Error("Nothing was captured"))).toBe("Nothing was captured");
    // A blank message is no message: the generic line is better than an empty note.
    expect(captureFailure(new Error("   "))).toBe("The browser could not capture a screenshot");
    expect(captureFailure("something odd")).toBe("The browser could not capture a screenshot");
  });
});
