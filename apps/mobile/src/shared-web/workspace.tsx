"use dom";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DOMProps } from "expo/dom";
import { DropdownMenu } from "radix-ui";
import { RefreshCw } from "lucide-react";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-bengali";
import "../../../web/src/app/globals.css";
import "./native-viewport.css";
import { AppShell } from "../../../web/src/components/app-shell";
import { Dashboard } from "../../../web/src/components/dashboard";
import { WorkspaceQuery } from "../../../web/src/components/workspace-query";
import { LoginForm } from "../../../web/src/components/login-form";
import { AccountRecoveryForm } from "../../../web/src/components/account-recovery-form";
import { WorkspaceResourcesProvider } from "../../../web/src/components/workspace-resources";
import type { CurrentUser } from "../../../web/src/lib/api";
import { NavigationContext } from "./navigation";
import { MobileUserContext } from "./session";
import { connectNativeApi } from "./api";
import type { BridgeRequest, BridgeResult } from "./types";
import { LocalData } from "./local-data";

export default function Workspace({
  pathname,
  user: marshalledUser,
  origin,
  pending,
  offline,
  blocked,
  lastSync,
  syncing,
  transferring = false,
  syncError,
  nativeViewport = false,
  onRequest,
  onNavigate,
  onOriginChange,
}: {
  dom?: DOMProps;
  pathname: string;
  user: CurrentUser | null;
  origin: string;
  pending: number;
  offline: boolean;
  blocked: number;
  lastSync: string | null;
  syncing: boolean;
  transferring?: boolean;
  syncError: string;
  nativeViewport?: boolean;
  onRequest: (request: BridgeRequest) => Promise<BridgeResult>;
  onNavigate: (href: string, replace?: boolean) => Promise<void>;
  onOriginChange: (origin: string) => Promise<void>;
}) {
  // The bridge deserializes objects again on every native status update.
  // Keep account identity stable until its actual data/permissions change.
  const serializedUser = JSON.stringify(marshalledUser);
  const user = useMemo<CurrentUser | null>(
    () => JSON.parse(serializedUser),
    [serializedUser],
  );
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const syncCycle = useRef({
    userId: user?.id,
    active: false,
    startedAt: lastSync,
  });
  useEffect(() => {
    const cycle = syncCycle.current;
    if (cycle.userId !== user?.id) {
      syncCycle.current = {
        userId: user?.id,
        active: transferring,
        startedAt: lastSync,
      };
      return;
    }
    if (transferring && !cycle.active) {
      cycle.active = true;
      cycle.startedAt = lastSync;
    } else if (!syncing && cycle.active) {
      cycle.active = false;
      if (
        lastSync &&
        lastSync !== cycle.startedAt &&
        pending === 0 &&
        blocked === 0 &&
        !syncError
      ) {
        const timer = window.setTimeout(() => setSyncedAt(lastSync), 0);
        return () => window.clearTimeout(timer);
      }
    }
  }, [user?.id, syncing, transferring, lastSync, pending, blocked, syncError]);
  useEffect(() => {
    if (!syncedAt) return;
    const timer = window.setTimeout(() => setSyncedAt(null), 3000);
    return () => window.clearTimeout(timer);
  }, [syncedAt]);
  const showSynced = Boolean(
    syncedAt && !transferring && pending === 0 && blocked === 0 && !syncError,
  );
  useLayoutEffect(() => {
    connectNativeApi(onRequest);
    return () => connectNativeApi(null);
  }, [onRequest]);
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      "data-native-workspace",
      nativeViewport,
    );
    return () =>
      document.documentElement.removeAttribute("data-native-workspace");
  }, [nativeViewport]);
  useEffect(() => {
    document.documentElement.lang = "bn";
    // The browser stylesheet is shared verbatim. Only platform safe areas live outside this DOM surface.
  }, []);
  useEffect(() => {
    if (lastSync) {
      // Revalidate in the background without clearing the visible form/options.
      window.dispatchEvent(new Event("focus"));
    }
  }, [lastSync]);
  const [moduleId, ...segments] = pathname
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  return (
    <NavigationContext.Provider value={{ pathname, navigate: onNavigate }}>
      <MobileUserContext.Provider value={user}>
        <WorkspaceResourcesProvider key={user?.id ?? "signed-out"} user={user}>
          {!user ? (
            <div className="mobile-auth">
              {moduleId === "forgot-password" ? (
                <AccountRecoveryForm mode="forgot" />
              ) : (
                <LoginForm deviceLogin />
              )}
              <details
                style={{
                  padding: "12px 24px",
                  background: "#fafbfe",
                  color: "#667085",
                  fontSize: 12,
                }}
              >
                <summary>Server connection</summary>
                <label>
                  Website address
                  <input
                    aria-label="Website address"
                    type="url"
                    defaultValue={origin}
                    onBlur={(event) => void onOriginChange(event.target.value)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: 10,
                      border: "1px solid #e3e7f0",
                      borderRadius: 8,
                      marginTop: 8,
                    }}
                  />
                </label>
              </details>
            </div>
          ) : (
            <AppShell
              deviceMenu={
                <DropdownMenu.Item
                  className="account-dropdown-item"
                  aria-label={`${pending} pending transactions`}
                  onSelect={() => void onNavigate("/sync")}
                >
                  <RefreshCw size={16} />
                  {pending} pending
                </DropdownMenu.Item>
              }
              headerStatus={
                (syncing && transferring) || showSynced ? (
                  <button
                    type="button"
                    className="header-pending-count header-sync-status"
                    data-synced={showSynced || undefined}
                    onClick={() => void onNavigate("/sync")}
                  >
                    <span role="status">
                      {syncing && transferring ? "Syncing…" : "Synced"}
                    </span>
                  </button>
                ) : null
              }
            >
              {moduleId === "sync" ? (
                <LocalData
                  origin={origin}
                  status={{
                    pending,
                    blocked,
                    offline,
                    lastSync,
                    syncing,
                    error: syncError,
                  }}
                />
              ) : moduleId === "dashboard" ? (
                <Dashboard />
              ) : (
                <WorkspaceQuery
                  key={pathname}
                  moduleId={moduleId || "dashboard"}
                  subpage={segments.join("/")}
                />
              )}
            </AppShell>
          )}
        </WorkspaceResourcesProvider>
      </MobileUserContext.Provider>
    </NavigationContext.Provider>
  );
}
