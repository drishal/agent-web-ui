// localStorage holds only harmless UI preferences; every access may throw
// (private windows, blocked storage), so everything degrades to defaults.
const PREFIX = "awui.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null || value === "") window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function rememberWorkspace(path: string): string[] {
  const recent = [path, ...load<string[]>("recentWorkspaces", []).filter((p) => p !== path)].slice(0, 8);
  save("recentWorkspaces", recent);
  return recent;
}

export function forgetWorkspace(path: string): string[] {
  const recent = load<string[]>("recentWorkspaces", []).filter((p) => p !== path);
  save("recentWorkspaces", recent);
  return recent;
}
