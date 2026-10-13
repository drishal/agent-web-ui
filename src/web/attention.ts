// What needs you, at a glance from another tab (T3 Code's thread
// notifications): the page title and the favicon carry a count of chats that
// ask for an answer or finished out of sight, and an optional chime plays when
// one does while the page is hidden. The count is pure; the favicon is drawn
// on a canvas from the app's own icon (a data: URL, which the CSP allows for
// images); the chime is two short tones from Web Audio, so there is no file.
import { load, save } from "./storage.js";

/** Chats that need you: asking for an answer, or finished in a tab not shown. A chat counts once. */
export function attentionCount(asking: Iterable<string>, unread: Iterable<string>): number {
  return new Set([...asking, ...unread]).size;
}

export function titleWith(count: number, title: string): string {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${title}` : title;
}

/** The icon at `src` with a count in a disc at its corner, as a PNG data URL. */
export async function badgedIcon(src: string, count: number, color: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const r = 17;
  ctx.beginPath();
  ctx.arc(size - r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 9 ? "9+" : String(count), size - r, r + 1);
  return canvas.toDataURL("image/png");
}

const SOUND_KEY = "chime";
export const chimeOn = (): boolean => load<boolean>(SOUND_KEY, false);
export const setChime = (on: boolean): void => save(SOUND_KEY, on || null);

let audio: AudioContext | null = null;

/**
 * Browsers only let a page play sound after a gesture on it, so the first
 * press makes the audio context; a chime later, from a hidden tab, then plays.
 */
export function primeAudio(): () => void {
  const prime = () => {
    if (!chimeOn() || audio) return;
    try {
      audio = new AudioContext();
    } catch {
      audio = null;
    }
  };
  window.addEventListener("pointerdown", prime, { capture: true });
  return () => window.removeEventListener("pointerdown", prime, { capture: true });
}

/** Two soft tones, a fifth apart. */
export function chime(): void {
  if (!chimeOn()) return;
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    void ctx.resume();
    [660, 990].forEach((freq, i) => {
      const at = ctx.currentTime + i * 0.13;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    // no audio here
  }
}
