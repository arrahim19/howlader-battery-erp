"use client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { DropdownMenu } from "radix-ui";
import { RefreshCw } from "lucide-react";
import { AppShell } from "./app-shell";
import { Dashboard } from "./dashboard";
import { ModulePage } from "./module-page";
import { DeviceSessionProvider } from "./session-provider";
import { DeviceNavigation } from "../lib/workspace-router";
import {
  connectDeviceApi,
  RESOURCE_CHANGED_EVENT,
  type CurrentUser,
} from "../lib/api";
import type { DeviceView } from "../../../../packages/local-erp/src/device";
import { devicePermissions } from "../../../../packages/local-erp/src/workspace-api";

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const snapshot = () =>
  window.location.hash.startsWith("#/")
    ? window.location.hash.slice(1)
    : "/dashboard";
export default function DeviceWorkspace({
  view,
  onRequest,
  onSync,
}: {
  view: DeviceView;
  onRequest: (route: string, init?: RequestInit) => Promise<unknown>;
  onSync: () => Promise<void>;
}) {
  const pathname = useSyncExternalStore(
    subscribe,
    snapshot,
    () => "/dashboard",
  );
  const serialized = JSON.stringify(view.user);
  const user = useMemo<CurrentUser>(() => {
    const u = JSON.parse(serialized);
    return {
      ...u,
      login: u.email,
      roles: ["OWNER"],
      permissions: devicePermissions,
    };
  }, [serialized]);
  useLayoutEffect(() => connectDeviceApi(onRequest), [onRequest]);
  useEffect(() => {
    window.dispatchEvent(new Event(RESOURCE_CHANGED_EVENT));
    window.dispatchEvent(new Event("hawlader:dashboard-update"));
  }, [view.sync.cloudRevision]);
  const navigation = useMemo(
    () => ({
      pathname,
      navigate: (href: string, replace = false) => {
        if (href === "__back__") {
          window.history.back();
          return;
        }
        if (href === "/login") return;
        if (!href.startsWith("/") || href.startsWith("//")) {
          window.location.assign(href);
          return;
        }
        if (replace) {
          window.history.replaceState(null, "", "#" + href);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } else window.location.hash = href;
      },
    }),
    [pathname],
  );
  const [moduleId = "dashboard", ...segments] = pathname
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  const title =
    view.sync.error ||
    (!view.ready
      ? "Drive restore শেষ না হওয়া পর্যন্ত নতুন হিসাব করা যাবে না।"
      : view.sync.pending
        ? "Saved on this device · Drive sync pending"
        : "Drive backup up to date");
  return (
    <DeviceNavigation.Provider value={navigation}>
      <DeviceSessionProvider user={user}>
        <AppShell
          deviceMenu={
            <>
              <DropdownMenu.Item
                className="account-dropdown-item"
                onSelect={() => void onSync().catch(() => {})}
              >
                <RefreshCw size={16} />
                Sync with Drive
              </DropdownMenu.Item>
            </>
          }
          deviceStatus={
            view.sync.error || !view.ready ? (
              <div
                role="status"
                className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
              >
                {title}
                <button
                  className="ml-3 underline"
                  onClick={() => void onSync().catch(() => {})}
                >
                  Retry sync
                </button>
              </div>
            ) : undefined
          }
        >
          {moduleId === "dashboard" ? (
            <Dashboard />
          ) : (
            <ModulePage
              key={pathname}
              module={moduleId}
              subpage={segments.join("/")}
              initialCustomerId={
                new URLSearchParams(pathname.split("?")[1] || "").get(
                  "customer",
                ) || undefined
              }
            />
          )}
        </AppShell>
      </DeviceSessionProvider>
    </DeviceNavigation.Provider>
  );
}
