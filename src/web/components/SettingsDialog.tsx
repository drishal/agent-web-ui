// Settings: this device's look (theme, text size, kept per browser), its
// sign-in and pairing, and the server's config.yml. The server section is
// editable only from the machine running the server (other devices read it);
// a save is checked server-side the way startup checks the file, and what
// takes a restart says so, with a Restart button when systemd supervises.
import { useEffect, useState, type CSSProperties } from "react";
import type { RestartSetting, ServerSettings, ServerSettingsValues, SettingsPatch, ThemeChoice } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import type { ThemeMode } from "../theme.js";
import { Dialog } from "./Dialog.js";
import { TEXT_SCALES } from "./Sidebar.js";

const RESTART_LABEL: Record<RestartSetting, string> = {
  port: "port",
  host: "listening address",
  username: "username",
  password: "password",
  workspaceRoots: "workspace roots",
  allowedHosts: "allowed hosts",
  allowedTailscaleUsers: "Tailscale users",
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const SCALE_MIN = TEXT_SCALES[0]?.[1] ?? 0.85;
const SCALE_MAX = TEXT_SCALES[TEXT_SCALES.length - 1]?.[1] ?? 1.35;

/** Nearest named stop, so a stored custom scale still reads sensibly. */
function sliderLabel(scale: number): string {
  let best = TEXT_SCALES[0]?.[0] ?? "";
  let gap = Infinity;
  for (const [label, value] of TEXT_SCALES) {
    const d = Math.abs(value - scale);
    if (d < gap) {
      gap = d;
      best = label;
    }
  }
  return `${Math.round(scale * 100)}% · ${best}`;
}

/** The form's working copy: lists as one entry per line, the password as a write-only field. */
interface Draft {
  port: string;
  host: ServerSettingsValues["host"];
  username: string;
  password: string;
  removePassword: boolean;
  workspaceRoots: string;
  allowedHosts: string;
  allowedTailscaleUsers: string;
  theme: ThemeChoice | "";
  autocollapseSidebar: boolean;
}

function draftOf(v: ServerSettingsValues): Draft {
  return {
    port: String(v.port),
    host: v.host,
    username: v.username,
    password: "",
    removePassword: false,
    workspaceRoots: v.workspaceRoots.join("\n"),
    allowedHosts: v.allowedHosts.join("\n"),
    allowedTailscaleUsers: v.allowedTailscaleUsers.join("\n"),
    theme: v.theme ?? "",
    autocollapseSidebar: v.autocollapseSidebar,
  };
}

/** Only what the form changed, so a save never rewrites a setting nobody touched. */
function patchOf(d: Draft, v: ServerSettingsValues): SettingsPatch {
  const p: SettingsPatch = {};
  const port = Number(d.port);
  if (d.port.trim() !== String(v.port)) p.port = port;
  if (d.host !== v.host) p.host = d.host;
  if (d.username.trim() !== v.username) p.username = d.username.trim();
  if (d.removePassword) p.password = null;
  else if (d.password) p.password = d.password;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(lines(d.workspaceRoots), v.workspaceRoots)) p.workspaceRoots = lines(d.workspaceRoots);
  if (!same(lines(d.allowedHosts), v.allowedHosts)) p.allowedHosts = lines(d.allowedHosts);
  if (!same(lines(d.allowedTailscaleUsers), v.allowedTailscaleUsers)) p.allowedTailscaleUsers = lines(d.allowedTailscaleUsers);
  if ((d.theme || null) !== v.theme) p.theme = d.theme || null;
  if (d.autocollapseSidebar !== v.autocollapseSidebar) p.autocollapseSidebar = d.autocollapseSidebar;
  return p;
}

export function SettingsDialog({
  themeMode,
  scheme,
  onThemeMode,
  textScale,
  onTextScale,
  onPair,
  signedInAs,
  onSignOut,
  version,
  onUiSaved,
  onClose,
}: {
  themeMode: ThemeMode;
  /** A theme.yml is loaded: offer its scheme. */
  scheme: { name: string | null } | null;
  onThemeMode: (mode: ThemeMode) => void;
  textScale: number;
  onTextScale: (scale: number) => void;
  onPair: () => void;
  signedInAs: string | null;
  onSignOut: () => void;
  version: string;
  /** The file's browser settings changed: the open page follows without a reload. */
  onUiSaved: (ui: { theme: ThemeChoice | null; autocollapseSidebar: boolean }) => void;
  onClose: () => void;
}) {
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    void api<ServerSettings>("/api/settings")
      .then((s) => {
        setServer(s);
        setDraft(draftOf(s.values));
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  const editable = Boolean(server?.editable && server.writable);
  const patch = server && draft ? patchOf(draft, server.values) : {};
  const dirty = Object.keys(patch).length > 0;
  const overridden = (key: keyof ServerSettingsValues) => server?.envOverrides.includes(key) ?? false;
  const field = (key: keyof ServerSettingsValues) => !editable || overridden(key);
  const update = (change: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setSaved(false);
  };

  const save = async () => {
    if (!server || !draft || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api<ServerSettings>("/api/settings", { method: "PUT", body: patch });
      setServer(next);
      setDraft(draftOf(next.values));
      setSaved(true);
      if (patch.theme !== undefined || patch.autocollapseSidebar !== undefined) {
        onUiSaved({ theme: next.values.theme, autocollapseSidebar: next.values.autocollapseSidebar });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /** systemd brings the server back; wait for it, then reload (on its new port, when that changed). */
  const restart = async () => {
    if (!server) return;
    setRestarting(true);
    setError(null);
    try {
      await api("/api/settings/restart", { body: {} });
    } catch (e) {
      setRestarting(false);
      setError(errorText(e));
      return;
    }
    const portChanged = server.restartPending.includes("port") && !server.envOverrides.includes("port");
    const origin = portChanged ? `${window.location.protocol}//${window.location.hostname}:${server.values.port}` : window.location.origin;
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() - started < 60_000) {
      try {
        const res = await fetch(`${origin}/api/health`, { cache: "no-store", mode: portChanged ? "no-cors" : "same-origin" });
        if (portChanged || res.ok) {
          window.location.assign(`${origin}${window.location.pathname}${window.location.hash}`);
          return;
        }
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    setRestarting(false);
    setError("The server has not come back yet; check its log (journalctl --user -u agent-web-ui).");
  };

  const pendingText = server?.restartPending.map((k) => RESTART_LABEL[k]).join(", ") ?? "";

  return (
    <Dialog title="Settings" onClose={onClose} className="dialog-wide settings-dialog">
      <section className="settings-section" aria-labelledby="settings-device">
        <h3 id="settings-device">This device</h3>
        <label className="settings-row">
          <span className="settings-label">Theme</span>
          <select className="select" aria-label="Theme" value={themeMode} onChange={(e) => onThemeMode(e.target.value as ThemeMode)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            {scheme ? (
              <option value="scheme" title={scheme.name ?? undefined}>
                base16
              </option>
            ) : null}
          </select>
        </label>
        <div className="settings-row settings-slider-row">
          <span className="settings-label" id="settings-text-size-label">
            Chat text size
          </span>
          <div className="text-slider">
            <input
              type="range"
              className="text-slider-input"
              aria-label="Chat text size"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.01}
              value={textScale}
              style={{ "--slider-fill": `${SCALE_MAX <= SCALE_MIN ? 0 : Math.min(100, Math.max(0, ((textScale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100))}%` } as CSSProperties}
              onChange={(e) => onTextScale(Number(e.target.value))}
            />
            <output className="text-slider-value" aria-live="off">
              {sliderLabel(textScale)}
            </output>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Other devices</span>
          <div className="settings-actions">
            <button type="button" className="btn btn-small" onClick={onPair}>
              Pair phone
            </button>
            {signedInAs ? (
              <button type="button" className="btn btn-small" onClick={onSignOut} title={`Signed in as ${signedInAs}`}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-server">
        <h3 id="settings-server">Server</h3>
        <p className="settings-note">
          {server && !server.writable
            ? "This server runs without a settings folder, so there is nothing to save to."
            : server && !server.editable
              ? "These live in config.yml on the machine running the server; change them there."
              : "Saved to config.yml. Theme and sidebar apply on the next page load; the rest when the server restarts."}
        </p>
        {!draft ? (
          error ? null : <p className="settings-note">Loading…</p>
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="settings-row">
              <span className="settings-label">Default theme</span>
              <select className="select" aria-label="Default theme" disabled={!editable} value={draft.theme} onChange={(e) => update({ theme: e.target.value as ThemeChoice | "" })}>
                <option value="">theme.yml if present, else system</option>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="base16">base16</option>
              </select>
            </label>
            <label className="settings-row settings-check">
              <input type="checkbox" disabled={!editable} checked={draft.autocollapseSidebar} onChange={(e) => update({ autocollapseSidebar: e.target.checked })} />
              <span>Fold the sidebar away in narrow windows</span>
            </label>
            <label className="settings-row">
              <span className="settings-label">Listen on</span>
              <select className="select" aria-label="Listen on" disabled={field("host")} value={draft.host} onChange={(e) => update({ host: e.target.value as Draft["host"] })}>
                <option value="127.0.0.1">This machine only (127.0.0.1)</option>
                <option value="0.0.0.0">All networks, with sign-in (0.0.0.0)</option>
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Port</span>
              <input className="input settings-port" aria-label="Port" inputMode="numeric" disabled={field("port")} value={draft.port} onChange={(e) => update({ port: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label className="settings-row">
              <span className="settings-label">Username</span>
              <input className="input" aria-label="Username" autoComplete="username" disabled={field("username")} value={draft.username} onChange={(e) => update({ username: e.target.value })} />
            </label>
            <label className="settings-row">
              <span className="settings-label">Password</span>
              <input
                className="input"
                type="password"
                aria-label="Password"
                autoComplete="new-password"
                disabled={field("hasPassword") || draft.removePassword}
                placeholder={server?.values.hasPassword ? "Set (type to change)" : "Not set"}
                value={draft.password}
                onChange={(e) => update({ password: e.target.value })}
              />
            </label>
            {server?.values.hasPassword && editable && !overridden("hasPassword") ? (
              <label className="settings-row settings-check">
                <input type="checkbox" checked={draft.removePassword} onChange={(e) => update({ removePassword: e.target.checked, password: "" })} />
                <span>Remove the password from config.yml</span>
              </label>
            ) : null}
            <label className="settings-row settings-stack">
              <span className="settings-label">Workspace roots</span>
              <textarea
                className="input"
                aria-label="Workspace roots"
                rows={2}
                disabled={field("workspaceRoots")}
                placeholder="Your home folder (one folder per line)"
                value={draft.workspaceRoots}
                onChange={(e) => update({ workspaceRoots: e.target.value })}
              />
            </label>
            <label className="settings-row settings-stack">
              <span className="settings-label">Allowed hosts</span>
              <textarea
                className="input"
                aria-label="Allowed hosts"
                rows={2}
                disabled={field("allowedHosts")}
                placeholder="e.g. machine.tailnet.ts.net (one per line)"
                value={draft.allowedHosts}
                onChange={(e) => update({ allowedHosts: e.target.value })}
              />
            </label>
            <label className="settings-row settings-stack">
              <span className="settings-label">Allowed Tailscale users</span>
              <textarea
                className="input"
                aria-label="Allowed Tailscale users"
                rows={2}
                disabled={field("allowedTailscaleUsers")}
                placeholder="Anyone on the tailnet who signs in (one login per line)"
                value={draft.allowedTailscaleUsers}
                onChange={(e) => update({ allowedTailscaleUsers: e.target.value })}
              />
            </label>
            {server && server.envOverrides.length > 0 ? (
              <p className="settings-note">Set by the environment, so config.yml cannot change: {server.envOverrides.join(", ")}.</p>
            ) : null}
            {error ? (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            ) : null}
            {server && server.restartPending.length > 0 ? (
              <div className="settings-restart" role="status">
                <span>Saved; takes effect after a restart: {pendingText}.</span>
                {server.canRestart && server.editable ? (
                  <button type="button" className="btn btn-small" disabled={restarting} onClick={() => void restart()}>
                    {restarting ? "Restarting…" : "Restart server"}
                  </button>
                ) : (
                  <span className="muted">Restart the server to apply.</span>
                )}
              </div>
            ) : saved ? (
              <p className="settings-note" role="status">
                Saved.
              </p>
            ) : null}
            {editable ? (
              <div className="settings-foot">
                <button type="button" className="btn btn-small btn-ghost" disabled={!dirty || saving} onClick={() => server && setDraft(draftOf(server.values))}>
                  Discard
                </button>
                <button type="submit" className="btn btn-small btn-primary" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            ) : null}
          </form>
        )}
        {!draft && error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <p className="settings-version">Agent Web UI v{version}</p>
    </Dialog>
  );
}
