"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@/lib/workspace-router";
import { AlertCircle, RefreshCw } from "lucide-react";
import {
  api,
  ApiError,
  SESSION_EXPIRED_EVENT,
  CURRENT_USER_CHANGED_EVENT,
  type CurrentUser,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { WorkspaceResourcesProvider } from "@/components/workspace-resources";

const SessionContext = createContext<CurrentUser | null>(null);
export function useSession() {
  return useContext(SessionContext);
}
/** Google enrollment already authenticated this account; no legacy API login. */
export function DeviceSessionProvider({
  user,
  children,
}: {
  user: CurrentUser;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={user}>
      <WorkspaceResourcesProvider
        key={user.shop?.id + ":" + user.id}
        user={user}
      >
        {children}
      </WorkspaceResourcesProvider>
    </SessionContext.Provider>
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    function expireSession() {
      setUser(null);
      setError("");
      router.replace("/login");
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);
    function refreshProfile() {
      api<CurrentUser>("/auth/me", { signal: controller.signal })
        .then((updated) => {
          if (!controller.signal.aborted) setUser(updated);
        })
        .catch(() => {
          /* The API handles expired sessions. Keep the current UI on a transient failure. */
        });
    }
    window.addEventListener(CURRENT_USER_CHANGED_EVENT, refreshProfile);
    api<CurrentUser>("/auth/me", { signal: controller.signal })
      .then((user) => {
        if (!controller.signal.aborted) setUser(user);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) return;
        setError(error instanceof Error ? error.message : "Unable to connect.");
      });
    return () => {
      controller.abort();
      window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
      window.removeEventListener(CURRENT_USER_CHANGED_EVENT, refreshProfile);
    };
  }, [router, retry]);
  return (
    <SessionContext.Provider value={user}>
      {error ? (
        <section
          role="alert"
          className="fixed inset-0 z-100 flex items-center justify-center bg-slate-50/95 p-6"
        >
          <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8">
            <AlertCircle className="mb-4 size-8 text-amber-500" />
            <h1 className="text-xl font-semibold">Workspace unavailable</h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">
              {error}
            </p>
            <p className="mt-3 text-xs text-slate-400">
              Start the API and database, then apply migrations. Setup
              instructions are in docs/DEVELOPMENT.md.
            </p>
            <Button
              className="mt-6"
              onClick={() => {
                setError("");
                setRetry((value) => value + 1);
              }}
            >
              <RefreshCw />
              Retry connection
            </Button>
          </div>
        </section>
      ) : null}
      <WorkspaceResourcesProvider key={user?.id ?? "static"} user={user}>
        {children}
      </WorkspaceResourcesProvider>
    </SessionContext.Provider>
  );
}
