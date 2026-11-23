import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { enrollOffline, unlockOffline } from "./offline/auth";
import { revokeOfflineEnrollment } from "./offline/auth";
import type { PasswordVerifier } from "./offline/password";
import {
  ApiError,
  ConnectionError,
  request,
  type CurrentUser,
  type Session,
} from "./client";
import { openLocalStore } from "./offline/local-store";
import {
  SyncEngine,
  scopeFor,
  retryable,
  type SyncStatus,
  type Submission,
} from "./offline/engine";

const storageKey = "hawlader.session.v1";
type SessionState = {
  local: SyncEngine | null;
  syncStatus: SyncStatus;
  submit: <T>(
    route: string,
    body: unknown,
    key: string,
  ) => Promise<Submission<T>>;
  user: CurrentUser | null;
  session: Session | null;
  loading: boolean;
  error: string;
  signIn: (
    origin: string,
    login: string,
    password: string,
    prepared?: PasswordVerifier,
  ) => Promise<void>;
  signOut: () => Promise<void>;
  forget: () => Promise<void>;
  retry: () => void;
  api: <T>(
    route: string,
    options?: {
      method?: string;
      body?: unknown;
      key?: string;
      signal?: AbortSignal;
    },
  ) => Promise<T>;
  can: (permission: string) => boolean;
  refreshUser: () => Promise<void>;
};
const Context = createContext<SessionState | null>(null);
const clearStored = () =>
  Platform.OS === "web"
    ? Promise.resolve()
    : SecureStore.deleteItemAsync(storageKey);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const current = useRef<Session | null>(null);
  const engine = useRef<SyncEngine | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const [local, setLocal] = useState<SyncEngine | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    offline: false,
    syncing: false,
    pending: 0,
    blocked: 0,
    lastSync: null,
    error: "",
  });
  useEffect(
    () => () => {
      engine.current?.stop();
      unsubscribe.current?.();
      current.current = null;
    },
    [],
  );
  const forget = useCallback(async () => {
    engine.current?.stop();
    unsubscribe.current?.();
    engine.current = null;
    setLocal(null);
    current.current = null;
    setSession(null);
    setUser(null);
    setError("");
    await clearStored();
  }, []);
  const activate = useCallback(
    async (saved: Session, account: CurrentUser, download = false) => {
      let ready = !download;
      const store = await openLocalStore();
      if (process.env.NODE_ENV !== "production")
        console.info("[login] local store opened");
      engine.current?.stop();
      unsubscribe.current?.();
      current.current = saved;
      const next = new SyncEngine(
        store,
        scopeFor(saved.origin, account.id, account.shop!.id),
        async <T,>(route: string, options = {}) => {
          if (current.current !== saved)
            throw new ApiError(401, "Account changed. Sign in again.");
          try {
            const result = await request<T>(saved.origin, route, {
              ...options,
              token: saved.accessToken,
            });
            if (current.current !== saved)
              throw new ApiError(401, "Account changed. Sign in again.");
            if (route === "/auth/me") {
              const identity = result as CurrentUser;
              if (
                identity.id !== account.id ||
                identity.shop?.id !== account.shop?.id
              )
                throw new ApiError(
                  403,
                  "Account or shop changed. Sign in again.",
                );
              if (ready) setUser(identity);
            }
            return result;
          } catch (error) {
            if (
              error instanceof ApiError &&
              error.status === 401 &&
              current.current === saved
            ) {
              throw new ConnectionError(
                "Local work is available. Sign in online again to resume cloud sync.",
              );
            }
            throw error;
          }
        },
        { localFirst: true },
      );
      await next.remember("/auth/me", account);
      if (process.env.NODE_ENV !== "production")
        console.info("[login] identity cached");
      // Returning devices can open their own saved data immediately after the
      // server verifies the account. The effect below refreshes it in background.
      if (download && !(await next.hasReplica())) {
        if (process.env.NODE_ENV !== "production")
          console.info("[login] first download started");
        await next.sync(true);
        if (process.env.NODE_ENV !== "production")
          console.info("[login] first download finished");
        if (!next.status.lastSync)
          throw new Error(
            next.status.error ||
              "Finish the first device download before working offline.",
          );
      }
      ready = true;
      await next.restoreStatus();
      engine.current = next;
      unsubscribe.current = next.subscribe(() => setSyncStatus(next.status));
      setLocal(next);
      setSyncStatus(next.status);
      setSession(saved);
      setUser(account);
      setError("");
    },
    [],
  );
  useEffect(() => {
    let mounted = true;
    async function startLocked() {
      try {
        // Active access is memory-only. Remove the legacy auto-restore token,
        // while retaining the encrypted offline verifier and SQLite journal.
        await clearStored();
      } catch (error) {
        if (mounted)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to initialize device login.",
          );
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void startLocked();
    return () => {
      mounted = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (!local) return;
    const sync = () => {
      if (AppState.currentState === "active" || Platform.OS === "web")
        void local.sync(true);
    };
    const connection = Network.addNetworkStateListener((state) => {
      local.network(state.isConnected !== false);
      if (state.isConnected !== false) sync();
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    const timer = setInterval(sync, 30000);
    void Network.getNetworkStateAsync()
      .then((state) => {
        local.network(state.isConnected !== false);
        sync();
      })
      .catch(sync);
    return () => {
      connection.remove();
      foreground.remove();
      clearInterval(timer);
    };
  }, [local]);
  const api = useCallback(
    async <T,>(
      route: string,
      options: {
        method?: string;
        body?: unknown;
        key?: string;
        signal?: AbortSignal;
      } = {},
    ) => {
      const active = current.current;
      if (!active) throw new ApiError(401, "Please sign in.");
      try {
        const result = await request<T>(active.origin, route, {
          ...options,
          token: active.accessToken,
        });
        if (route === "/auth/change-password") await revokeOfflineEnrollment();
        return result;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          current.current === active
        )
          await forget();
        throw error;
      }
    },
    [forget],
  );
  async function signIn(
    origin: string,
    login: string,
    password: string,
    prepared?: PasswordVerifier,
  ) {
    const started = Date.now();
    const mark = (stage: string) => {
      if (process.env.NODE_ENV !== "production")
        console.info(`[login] ${stage}: ${Date.now() - started}ms`);
    };
    mark("started");
    let result: { accessToken: string; expiresAt: string };
    try {
      const network = await Network.getNetworkStateAsync();
      if (network.isConnected === false)
        throw new ConnectionError("No network connection.");
      result = await request(origin, "/auth/mobile/login", {
        method: "POST",
        body: { login: login.trim().toLowerCase(), password },
      });
      mark("server login complete");
    } catch (failure) {
      if (!retryable(failure)) throw failure;
      const enrolled = await unlockOffline(origin, login, password, prepared);
      mark("offline password complete");
      if (!enrolled)
        throw new Error(
          "Connect once to sign in and download this shop on this device. After setup, offline login is available.",
        );
      await activate(enrolled.session, enrolled.user);
      engine.current?.network(false);
      return;
    }
    const saved = { origin, ...result };
    try {
      const account = await request<CurrentUser>(origin, "/auth/me", {
        token: saved.accessToken,
      });
      mark("identity complete");
      const bound = { ...saved, userId: account.id, shopId: account.shop?.id };
      await activate(bound, account, true);
      mark("local workspace ready");
      // Enroll only a server-verified account. Plaintext passwords are never persisted.
      await enrollOffline(origin, login, password, bound, account, prepared);
      mark("offline enrollment complete");
    } catch (error) {
      await request(origin, "/auth/logout", {
        method: "POST",
        body: {},
        token: saved.accessToken,
      }).catch(() => {});
      await forget();
      throw error;
    }
  }
  async function signOut() {
    try {
      if (current.current && !engine.current?.status.offline)
        await api("/auth/logout", { method: "POST", body: {} });
    } catch (failure) {
      if (!retryable(failure)) throw failure;
    } finally {
      await forget();
    }
  }
  return (
    <Context.Provider
      value={{
        local,
        syncStatus,
        submit: async <T,>(route: string, body: unknown, key: string) => {
          if (!engine.current) throw new Error("Local database is not ready.");
          return engine.current.submit<T>(route, body, key);
        },
        user,
        session,
        loading,
        error,
        signIn,
        signOut,
        forget,
        refreshUser: async () => {
          const account = await api<CurrentUser>("/auth/me");
          setUser(account);
        },
        retry: () => {
          setLoading(true);
          setError("");
          setAttempt((value) => value + 1);
        },
        api,
        can: (permission) => Boolean(user?.permissions.includes(permission)),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("Session provider is missing.");
  return value;
}
