// The app-wide banner: state plus `fail(e)`, the one catch body every API
// action shares instead of inlining setBanner({ level: "error", text: ... }).
import { useState } from "react";
import { errorText } from "./api.js";

export type BannerLevel = "info" | "warning" | "error";
export type Banner = { level: BannerLevel; text: string } | null;

export function useBanner() {
  const [banner, setBanner] = useState<Banner>(null);
  /** Report a caught error; only `answer()`'s 409 uses a non-error level. */
  const fail = (e: unknown, level: BannerLevel = "error"): void => setBanner({ level, text: errorText(e) });
  return { banner, setBanner, fail };
}
