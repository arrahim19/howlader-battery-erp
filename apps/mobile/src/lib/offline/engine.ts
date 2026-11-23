import { ApiError, ConnectionError } from "../client";
import type { LocalStore } from "./store-types";
import { localResult, readReplica, type ReplicaSnapshot } from "./replica";

export type Command = {
  id: string;
  route: string;
  body: unknown;
  createdAt: string;
  state: "pending" | "blocked" | "done";
  error: string;
  result?: unknown;
  localResult?: unknown;
};
export type Cached<T> = { data: T; at: string };
export type SyncStatus = {
  offline: boolean;
  syncing: boolean;
  transferring?: boolean;
  pending: number;
  blocked: number;
  lastSync: string | null;
  error: string;
};
export type Submission<T> =
  { queued: true; id: string } | { queued: false; data: T };
export type Send = <T>(
  route: string,
  options?: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  },
) => Promise<T>;
export const scopeFor = (origin: string, user: string, shop: string) =>
  JSON.stringify([origin, shop, user]);
export function routeKey(route: string) {
  const url = new URL(route, "https://local.invalid");
  for (const [key, value] of [...url.searchParams])
    if (value === "") url.searchParams.delete(key);
  url.searchParams.sort();
  return url.pathname + (url.search ? url.search : "");
}
export const queueable = (route: string) =>
  [
    "/sales/complete",
    "/purchases/receive",
    "/expenses",
    "/customers",
    "/suppliers",
    "/products",
    "/categories",
    "/replacements",
    "/settings/shop",
  ].includes(route) ||
  /^\/replacements\/[a-zA-Z0-9-]+\/status$/.test(route) ||
  /^\/customers\/[a-zA-Z0-9-]+\/payments$/.test(route);
export const retryable = (error: unknown) =>
  error instanceof ConnectionError ||
  (error instanceof ApiError &&
    (error.status === 408 || error.status === 429 || error.status >= 500));

export class SyncEngine {
  status: SyncStatus = {
    offline: false,
    syncing: false,
    pending: 0,
    blocked: 0,
    lastSync: null,
    error: "",
  };
  private stopped = false;
  private connected = true;
  private flight: Promise<void> | null = null;
  private primed = false;
  private localTail: Promise<unknown> = Promise.resolve();
  private rerun = false;
  private snapshotCache: ReplicaSnapshot | null = null;
  private rendered = new Map<string, unknown>();
  private invalidateLocal() {
    this.rendered.clear();
  }
  private async snapshot() {
    return (
      this.snapshotCache ??
      (this.snapshotCache = await this.store.get<ReplicaSnapshot>(
        this.key("replica", "v1"),
      ))
    );
  }
  private listeners = new Set<() => void>();
  constructor(
    readonly store: LocalStore,
    readonly scope: string,
    private send: Send,
    private options: { localFirst?: boolean } = {},
  ) {}
  private key(kind: string, id = "") {
    return `${this.scope}:${kind}:${id}`;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(change: Partial<SyncStatus> = {}) {
    if (this.stopped) return;
    const next = { ...this.status, ...change };
    if (
      (Object.keys(next) as (keyof SyncStatus)[]).every((key) =>
        Object.is(next[key], this.status[key]),
      )
    )
      return;
    this.status = next;
    this.listeners.forEach((listener) => listener());
  }
  stop() {
    this.stopped = true;
    this.listeners.clear();
  }
  network(available: boolean) {
    this.connected = available;
    this.publish({ offline: !available });
  }
  async counts() {
    const commands = await this.commands();
    this.publish({
      pending: commands.filter((item) => item.state === "pending").length,
      blocked: commands.filter((item) => item.state === "blocked").length,
    });
  }
  async restoreStatus() {
    const lastSync = await this.store.get<string>(this.key("meta", "lastSync"));
    this.publish({ lastSync });
    await this.counts();
  }
  async hasReplica() {
    const saved = await this.snapshot();
    const identity = saved?.views["/auth/me"] as
      { id?: string; shop?: { id?: string } } | undefined;
    const [, shop, user] = JSON.parse(this.scope) as string[];
    return identity?.id === user && identity?.shop?.id === shop;
  }
  async commands() {
    return (await this.store.list<Command>(this.key("outbox")))
      .map((row) => row.value)
      .filter((row) => row.state !== "done")
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }
  async cached<T>(route: string) {
    return this.store.get<Cached<T>>(this.key("cache", routeKey(route)));
  }
  private journal() {
    return this.store
      .list<Command>(this.key("outbox"))
      .then((rows) =>
        rows
          .map((r) => r.value)
          .sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          ),
      );
  }
  async receipt(id: string) {
    const command = await this.store.get<Command>(this.key("outbox", id));
    if (!command) throw new Error("Local receipt not found.");
    if (command.state === "blocked") throw new ApiError(409, command.error);
    return command.state === "done" ? command.result : command.localResult;
  }
  async remember(route: string, data: unknown) {
    await this.store.put(this.key("cache", routeKey(route)), {
      data,
      at: new Date().toISOString(),
    });
  }
  async read<T>(
    route: string,
    signal?: AbortSignal,
  ): Promise<Cached<T> & { stale: boolean }> {
    if (this.options.localFirst) {
      const snapshot = await this.snapshot();
      if (snapshot) {
        const key =
          routeKey(route) + ":" + new Date().toISOString().slice(0, 13);
        let data = this.rendered.get(key);
        if (data === undefined) {
          data = readReplica(snapshot, await this.journal(), route);
          if (data !== undefined) {
            if (this.rendered.size > 200) this.rendered.clear();
            this.rendered.set(key, data);
          }
        }
        if (data !== undefined)
          return {
            data: data as T,
            at: snapshot.at,
            stale: this.status.offline,
          };
      }
      const cached = await this.cached<T>(route);
      if (cached) return { ...cached, stale: this.status.offline };
    }
    try {
      if (!this.connected) throw new ConnectionError("No network connection.");
      const data = await this.send<T>(route, { signal });
      await this.remember(route, data);
      this.publish({ offline: false });
      return { data, at: new Date().toISOString(), stale: false };
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        await this.store.remove(this.key("cache", routeKey(route)));
      if (signal?.aborted || !retryable(error)) throw error;
      this.publish({ offline: true });
      const saved = await this.cached<T>(route);
      if (!saved)
        throw new Error(
          "This page has not been downloaded yet. Connect to the server first.",
        );
      return { ...saved, stale: true };
    }
  }
  async submit<T>(
    route: string,
    body: unknown,
    id: string,
  ): Promise<Submission<T>> {
    if (this.options.localFirst) {
      const work = this.localTail.then(async (): Promise<Submission<T>> => {
        if (this.stopped) throw new Error("Sign in again before saving.");
        if (!queueable(route) || !/^[a-f0-9-]{36}$/i.test(id))
          throw new Error("This operation requires an online connection.");
        const key = this.key("outbox", id),
          existing = await this.store.get<Command>(key);
        if (existing) {
          if (
            existing.route !== route ||
            JSON.stringify(existing.body) !== JSON.stringify(body)
          )
            throw new Error(
              "This saved operation has different data. Use a new operation.",
            );
          if (existing.state === "blocked") throw new Error(existing.error);
          if (existing.state === "done")
            return { queued: false, data: existing.result as T };
          if (existing.localResult)
            return { queued: false, data: existing.localResult as T };
        }
        const snapshot = await this.store.get<ReplicaSnapshot>(
          this.key("replica", "v1"),
        );
        if (!snapshot)
          throw new Error(
            "Finish the first device download before posting offline.",
          );
        const journal = await this.journal();
        const lastCreatedAt = journal.reduce(
          (latest, entry) => Math.max(latest, Date.parse(entry.createdAt) || 0),
          0,
        );
        const result = localResult(snapshot, journal, route, body, id);
        await this.store.put(key, {
          id,
          route,
          body,
          createdAt:
            existing?.createdAt ||
            new Date(Math.max(Date.now(), lastCreatedAt + 1)).toISOString(),
          state: "pending",
          error: "",
          localResult: result,
        } satisfies Command);
        this.invalidateLocal();
        await this.counts();
        // Persistence is the commit. Upload is separate from local form completion.
        if (this.flight) this.rerun = true;
        void this.sync(true);
        return { queued: false, data: result as T };
      });
      this.localTail = work.catch(() => {});
      return work;
    }
    if (this.stopped) throw new Error("Sign in again before saving.");
    if (
      !(
        ["/sales/complete", "/purchases/receive", "/expenses"].includes(
          route,
        ) || /^\/customers\/[a-zA-Z0-9-]+\/payments$/.test(route)
      ) ||
      !/^[a-f0-9-]{36}$/i.test(id)
    )
      throw new Error("This action needs an online connection.");
    const key = this.key("outbox", id);
    await this.store.insert(key, {
      id,
      route,
      body,
      createdAt: new Date().toISOString(),
      state: "pending",
      error: "",
    } satisfies Command);
    const saved = (await this.store.get<Command>(key))!;
    if (
      saved.route !== route ||
      JSON.stringify(saved.body) !== JSON.stringify(body)
    )
      throw new Error(
        "This transaction is already saved on this device. Open Sync & local data to review it.",
      );
    if (saved.state === "done")
      return { queued: false, data: saved.result as T };
    // An older sync may already have taken its outbox snapshot and be
    // downloading pages. Finish that flight before asking it to replay this
    // newly persisted command; otherwise an online save can remain pending.
    if (this.flight) {
      await this.flight;
      const current = (await this.store.get<Command>(key))!;
      if (current.state === "done")
        return { queued: false, data: current.result as T };
      if (
        current.state === "blocked" ||
        this.status.offline ||
        this.status.error
      )
        return { queued: true, id };
    }
    await this.sync();
    const result = (await this.store.get<Command>(key))!;
    if (result.state === "done")
      return { queued: false, data: result.result as T };
    // A rejected transaction is retained for review, rather than silently discarded.
    return { queued: true, id };
  }
  sync(refresh = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.perform(refresh).finally(() => {
      this.flight = null;
      if (this.rerun && this.connected && !this.status.error && !this.stopped) {
        this.rerun = false;
        void this.sync(true);
      }
    });
    return this.flight;
  }
  private async perform(refresh: boolean) {
    this.publish({ syncing: true, transferring: false, error: "" });
    try {
      if (!this.connected) throw new ConnectionError("No network connection.");
      // Revalidate the session/shop before replaying any stored operation.
      const identity = await this.send<{ id: string; shop?: { id: string } }>(
        "/auth/me",
      );
      const [, shop, user] = JSON.parse(this.scope) as string[];
      if (identity.id !== user || identity.shop?.id !== shop)
        throw new ApiError(403, "Account or shop changed. Sign in again.");
      this.publish({ offline: false });
      for (const command of await this.commands()) {
        if (this.stopped) return;
        if (command.state === "blocked") break; // Preserve financial ordering.
        this.publish({ transferring: true });
        try {
          const result = await this.send(command.route, {
            method: "POST",
            body: command.body,
            key: command.id,
          });
          await this.store.put(this.key("outbox", command.id), {
            ...command,
            state: "done",
            error: "",
            result,
          });
          this.invalidateLocal();
          refresh = true;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) throw error;
          const message =
            error instanceof Error ? error.message : "Sync failed.";
          await this.store.put(this.key("outbox", command.id), {
            ...command,
            state: retryable(error) ? "pending" : "blocked",
            error: message,
          });
          this.invalidateLocal();
          if (retryable(error)) throw error;
          this.publish({
            error: "A transaction needs review. Later transactions are paused.",
          });
          break;
        }
      }
      if (refresh && !this.stopped && !this.options.localFirst) {
        for (const entry of await this.store.list<Cached<unknown>>(
          this.key("cache"),
        )) {
          if (this.stopped) return;
          const route = entry.key.slice(this.key("cache").length);
          try {
            await this.remember(route, await this.send(route));
          } catch (error) {
            if (
              error instanceof ApiError &&
              (error.status === 403 || error.status === 404)
            )
              await this.store.remove(entry.key);
            else throw error;
          }
        }
      }
      if (
        (!this.primed || refresh) &&
        !this.stopped &&
        this.options.localFirst
      ) {
        await this.downloadReplica();
        this.primed = true;
      } else if ((!this.primed || refresh) && !this.stopped) {
        const account = identity as { id: string; permissions?: string[] };
        const can = (permission: string) =>
          account.permissions?.includes(permission);
        const downloads = [
          ["dashboard.read", "/dashboard"],
          ["sales.manage", "/sales/options"],
          ["purchases.manage", "/purchases/options"],
          ["catalog.write", "/catalog?status=active"],
          ["finance.read", "/expenses/options"],
          [
            "replacements.intake.customer",
            "/replacements/options?source=CUSTOMER_WARRANTY",
          ],
        ];
        for (const [permission, route] of downloads) {
          if (this.stopped) return;
          if (can(permission))
            await this.remember(route, await this.send(route));
        }
        const lists = [
          ["sales.manage", "/sales"],
          ["purchases.manage", "/purchases"],
          ["parties.customers", "/customers"],
          ["parties.suppliers", "/suppliers"],
          ["inventory.read", "/products"],
          ["finance.read", "/expenses"],
          ["replacements.intake.customer", "/replacements"],
        ];
        for (const [permission, route] of lists) {
          if (!can(permission)) continue;
          for (let page = 1; ; page++) {
            if (this.stopped) return;
            const path = `${route}?page=${page}&pageSize=20`;
            const result = await this.send<{ items: unknown[]; total: number }>(
              path,
            );
            await this.remember(path, result);
            if (!result.items?.length || page * 20 >= result.total) break;
          }
        }
        this.primed = true;
      }
      const lastSync = new Date().toISOString();
      await this.store.put(this.key("meta", "lastSync"), lastSync);
      this.publish({ lastSync });
    } catch (error) {
      this.publish({
        offline: retryable(error),
        error: error instanceof Error ? error.message : "Sync failed.",
      });
    } finally {
      try {
        await this.counts();
      } catch (error) {
        this.publish({
          error:
            error instanceof Error
              ? error.message
              : "Local database unavailable.",
        });
      } finally {
        this.publish({ syncing: false, transferring: false });
      }
    }
  }
  private async downloadReplica() {
    const acknowledged = (await this.journal())
      .filter((c) => c.state === "done")
      .map((c) => c.id);
    const previous = await this.store.get<ReplicaSnapshot>(
      this.key("replica", "v1"),
    );
    const previousIds = new Set(previous?.acknowledged || []);
    if (
      previous?.businessVersion &&
      acknowledged.every((id) => previousIds.has(id))
    ) {
      const current = await this.send<{ version: string }>(
        "/mobile/offline-version",
      );
      if (current.version === previous.businessVersion) return;
    }
    this.publish({ transferring: true });
    const response = await this.send<{
      views: Record<string, unknown>;
      at: string;
      version: number;
      businessVersion: string;
    }>("/mobile/offline-bootstrap");
    if (this.stopped) return;
    if (response.version !== 1 || !response.views["/auth/me"])
      throw new Error("Invalid device download. Try sync again.");
    const identity = response.views["/auth/me"] as {
      id: string;
      shop?: { id: string };
    };
    const [, shop, user] = JSON.parse(this.scope) as string[];
    if (identity.id !== user || identity.shop?.id !== shop)
      throw new ApiError(
        403,
        "Device download belongs to another account or shop.",
      );
    await this.store.put(this.key("replica", "v1"), {
      views: response.views,
      acknowledged,
      at: response.at,
      businessVersion: response.businessVersion,
    } satisfies ReplicaSnapshot);
    this.snapshotCache = null;
    this.invalidateLocal();
  }
  async retry(id: string) {
    this.invalidateLocal();
    const key = this.key("outbox", id);
    const saved = await this.store.get<Command>(key);
    if (saved?.state === "blocked")
      await this.store.put(key, { ...saved, state: "pending", error: "" });
    this.invalidateLocal();
    await this.sync(true);
  }
  async discardRejected(id: string) {
    this.invalidateLocal();
    const key = this.key("outbox", id);
    const saved = await this.store.get<Command>(key);
    if (saved?.state !== "blocked")
      throw new Error("Only a server-rejected transaction can be removed.");
    await this.store.remove(key);
    this.invalidateLocal();
    await this.counts();
  }
}
