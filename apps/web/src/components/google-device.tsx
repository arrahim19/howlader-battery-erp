"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleAccountLogin,
  webSnapshotCrypto,
  type GoogleLoginGrant,
  type PendingGoogleLogin,
} from "../../../../packages/drive-sync/src";
import { LocalDevice } from "../../../../packages/local-erp/src/device";
import { browserDatabase } from "../../../../packages/local-erp/src/browser-store";
import deployment from "../../../../google-apps-script/deployment.json";
import type { DeviceView } from "../../../../packages/local-erp/src/device";
import DeviceWorkspace from "./device-workspace";
import { LocalWorkspaceApi } from "../../../../packages/local-erp/src/workspace-api";
import { LoginForm } from "./login-form";

export default function GoogleDevice() {
  const runtime = useRef<LocalDevice | null>(null),
    db = useRef<Awaited<ReturnType<typeof browserDatabase>> | null>(null);
  const workspaceApi = useRef<LocalWorkspaceApi | null>(null);
  const pollingRef = useRef(false);
  const [view, setView] = useState<DeviceView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    if (runtime.current) setView(await runtime.current.view());
  }, []);
  const activate = useCallback(
    async (grant: GoogleLoginGrant) => {
      if (!db.current) throw new Error("Desktop storage is unavailable.");
      runtime.current?.stop();
      const { store, repository } = db.current.business(grant.user.shop.id);
      const next = new LocalDevice(
        grant,
        deployment.url,
        store,
        repository,
        webSnapshotCrypto,
      );
      runtime.current = next;
      workspaceApi.current = new LocalWorkspaceApi(next);
      try {
        await next.open();
        setError("");
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Restore failed. Local data retained.",
        );
      }
      await refresh();
    },
    [refresh],
  );
  useEffect(() => {
    let alive = true,
      polling = false;
    async function check() {
      if (
        !db.current ||
        polling ||
        pollingRef.current ||
        document.visibilityState !== "visible"
      )
        return;
      polling = true;
      pollingRef.current = true;
      try {
        const proof = await db.current.secret<PendingGoogleLogin>("pending");
        if (proof) {
          const login = new GoogleAccountLogin(deployment.url),
            result = await login.poll(proof);
          if (result.status === "complete") {
            await db.current.saveSecret("grant", result.grant);
            await db.current.saveSecret("pending", null);
            if (alive) {
              setPending(false);
              await activate(result.grant);
            }
            await login.acknowledge(proof).catch(() => {});
          }
        }
      } catch (e) {
        if (
          alive &&
          e instanceof Error &&
          "code" in e &&
          e.code === "LOGIN_EXPIRED" &&
          runtime.current &&
          (await runtime.current.view()).ready
        ) {
          await db.current?.saveSecret("pending", null);
          setPending(false);
          setError("");
        } else if (alive)
          setError(e instanceof Error ? e.message : "Google sign-in failed.");
      } finally {
        polling = false;
        pollingRef.current = false;
      }
    }
    void browserDatabase()
      .then(async (storage) => {
        if (!alive) return;
        db.current = storage;
        setPending(Boolean(await storage.secret("pending")));
        const saved = await storage.secret<GoogleLoginGrant>("grant");
        if (alive && saved) await activate(saved);
        if (alive) await check();
      })
      .catch((e) => {
        if (alive)
          setError(e instanceof Error ? e.message : "Local storage failed.");
      });
    const poll = setInterval(() => void check(), 3000);
    const sync = async () => {
      if (!runtime.current || document.visibilityState !== "visible") return;
      try {
        await runtime.current.sync();
        if (alive) setError("");
      } catch {}
      if (alive) await refresh();
    };
    const timer = setInterval(() => void sync(), 10000),
      foreground = () => {
        void check();
        void sync();
      };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
      runtime.current?.stop();
      runtime.current = null;
    };
  }, [activate, refresh]);
  async function login() {
    if (busy || !db.current) return;
    const popup = window.open("about:blank", "_blank");
    setBusy(true);
    setError("");
    try {
      let id = await db.current.get<string>("device-id");
      if (!id) {
        id = webSnapshotCrypto.randomId();
        await db.current.put("device-id", id);
      }
      const client = new GoogleAccountLogin(deployment.url),
        proof = client.prepare(id, "Desktop browser");
      await db.current.saveSecret("pending", proof);
      const result = await client.start(proof);
      if (!popup)
        throw new Error("Allow the Google sign-in popup, then try again.");
      popup.location.href = result.url;
      setPending(true);
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  const onRequest = useCallback(
    async (route: string, init?: RequestInit) => {
      if (route === "/auth/logout") {
        if (runtime.current) await runtime.current.handoff();
        runtime.current?.stop();
        runtime.current = null;
        workspaceApi.current = null;
        setView(null);
        return null;
      }
      if (!workspaceApi.current)
        throw new Error("Local database is connecting.");
      const headers = new Headers(init?.headers);
      try {
        return await workspaceApi.current.request(
          route,
          init?.method || "GET",
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          headers.get("Idempotency-Key") || undefined,
        );
      } finally {
        if (init?.method && init.method !== "GET") await refresh();
      }
    },
    [refresh],
  );
  return (
    <>
      {error && (
        <div role="alert" style={{ padding: 16, background: "#fff8e5" }}>
          {error}
          {view && (
            <button
              onClick={() => {
                runtime.current?.stop();
                runtime.current = null;
                setView(null);
              }}
            >
              Google sign-in / renew access
            </button>
          )}
        </div>
      )}
      {view ? (
        <DeviceWorkspace
          view={view}
          onRequest={onRequest}
          onSync={async () => {
            if (runtime.current) {
              try {
                await runtime.current.sync();
                setError("");
              } finally {
                await refresh();
              }
            }
          }}
        />
      ) : (
        <LoginForm
          googleLogin={{ busy, pending, onClick: () => void login() }}
        />
      )}
    </>
  );
}
