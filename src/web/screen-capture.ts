// Capturing a window or a screen into the composer (T3 Code's SnapShots, without
// a native helper). getDisplayMedia gives a live video track, the first painted
// frame is drawn onto a canvas and handed to the image pipeline as a PNG, so it
// is bounded, stored, and sent exactly like a pasted screenshot. The browser
// always asks which surface to share; nothing is captured silently.

/** getDisplayMedia is missing on plain-HTTP LAN pages and on most phones: the button hides. */
export function screenCaptureAvailable(devices: { getDisplayMedia?: unknown } | null | undefined): boolean {
  return typeof devices?.getDisplayMedia === "function";
}

export function canCaptureScreen(): boolean {
  return typeof navigator !== "undefined" && screenCaptureAvailable(navigator.mediaDevices);
}

/**
 * Why a capture failed, as one line for the composer; null when the user simply
 * closed the picker, which is not news.
 */
export function captureFailure(error: unknown): string | null {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "AbortError") return null;
  if (name === "NotFoundError") return "No window was available to capture";
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "The browser could not capture a screenshot";
}

const FRAME_WAIT_MS = 3000;

/** Wait until the track has painted a frame, so drawImage has pixels to read. */
async function firstFrame(video: HTMLVideoElement): Promise<void> {
  const deadline = Date.now() + FRAME_WAIT_MS;
  while (!video.videoWidth && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  // videoWidth only says the track is live; give the first paint a moment to land.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    const ask = (video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number }).requestVideoFrameCallback;
    if (typeof ask !== "function") {
      clearTimeout(timer);
      resolve();
      return;
    }
    ask.call(video, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The shared surface's first frame as a PNG file; null when the user cancels. */
export async function captureScreen(): Promise<File | null> {
  if (!canCaptureScreen()) throw new Error("This browser cannot capture a window");
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // A stream that refuses to play still paints its first frame; the wait below decides.
    await video.play().catch(() => undefined);
    await firstFrame(video);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("Nothing was captured");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the capture");
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The capture could not be encoded");
    return new File([blob], "screenshot.png", { type: "image/png" });
  } catch (error) {
    const reason = captureFailure(error);
    if (reason === null) return null;
    throw new Error(reason);
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}
