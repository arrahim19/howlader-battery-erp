"use client";
import { useEffect, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { api, post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type BackupStatus = {
  storageMode?: "local-drive";
  enabled: boolean;
  administrator: boolean;
  running: boolean;
  localAt: string | null;
  driveAt: string | null;
  pending: number;
  error: string | null;
  googleConfigured?: boolean;
  driveConnected?: boolean;
  redirectUri?: string;
};
export function BackupSettings({ preview = false }: { preview?: boolean }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (preview) return;
    let active = true;
    const load = () =>
      api<BackupStatus>("/backups/status")
        .then((value) => {
          if (active) {
            setStatus(value);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Unable to load backup status.");
        });
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [preview]);
  const timestamp = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString() : "Not yet";
  async function run() {
    setBusy(true);
    setError("");
    try {
      setStatus(await post<BackupStatus>("/backups/run", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backup failed; please retry.");
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ url: string }>("/backups/google/connect", {});
      const url = new URL(result.url);
      if (url.origin !== "https://accounts.google.com")
        throw new Error("Invalid Google authorization address.");
      window.location.assign(url.href);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect Google Drive.",
      );
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic backups</CardTitle>
        <Cloud size={18} className="text-emerald-600" />
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          {status?.storageMode === "local-drive"
            ? "Shop records are saved on this device. Encrypted backups automatically sync to the owner's Google Drive."
            : "Shop records are stored on the local server. Encrypted backups from all shops are sent to the backup administrator’s Google Drive."}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt>Automatic backup</dt>
          <dd>
            {status
              ? status.enabled
                ? "Enabled"
                : "Not configured"
              : preview
                ? "Preview"
                : "Loading…"}
          </dd>
          <dt>Last local backup</dt>
          <dd>{timestamp(status?.localAt)}</dd>
          <dt>Last Drive upload</dt>
          <dd>{timestamp(status?.driveAt)}</dd>
          <dt>Pending uploads</dt>
          <dd>{status?.pending ?? "—"}</dd>
          {status?.administrator ? (
            <>
              <dt>Google Drive</dt>
              <dd>{status.driveConnected ? "Connected" : "Not connected"}</dd>
            </>
          ) : null}
        </dl>
        {status?.administrator && !status.googleConfigured ? (
          <p className="text-xs text-amber-700">
            Google setup required. Add the OAuth client credentials to the
            server configuration, restart, then connect your Drive. Redirect
            URI: <code className="break-all">{status.redirectUri}</code>
          </p>
        ) : null}
        {status?.administrator ? (
          <div className="flex flex-wrap gap-2">
            {status.storageMode !== "local-drive" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || !status.enabled || !status.googleConfigured}
                onClick={() => void connect()}
              >
                <Cloud size={15} />
                {status.driveConnected
                  ? "Reconnect Google Drive"
                  : "Connect Google Drive"}
              </Button>
            )}
            <Button
              type="button"
              disabled={busy || status.running || !status.enabled}
              onClick={() => void run()}
            >
              <RefreshCw
                size={15}
                className={busy || status.running ? "animate-spin" : ""}
              />
              {busy || status.running ? "Backing up…" : "Back up now"}
            </Button>
          </div>
        ) : null}
        {status?.enabled && status.administrator && !status.driveConnected ? (
          <p className="text-xs text-amber-700">
            Local backups are active. Drive uploads will start after you connect
            Google Drive.
          </p>
        ) : null}
        {error || status?.error ? (
          <p role="alert" className="text-xs text-red-700">
            {error || status?.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
