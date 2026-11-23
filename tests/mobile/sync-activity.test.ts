import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncEngine, scopeFor } from "../../apps/mobile/src/lib/offline/engine";
import type { LocalStore } from "../../apps/mobile/src/lib/offline/store-types";

test("idle version checks stay quiet; changed records report an actual transfer", async () => {
  const values = new Map<string, unknown>();
  const store: LocalStore = {
    async get<T>(key: string) {
      return (values.get(key) as T) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async insert(key, value) {
      if (!values.has(key)) values.set(key, value);
    },
    async list<T>(prefix: string) {
      return [...values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: value as T }));
    },
    async remove(key) {
      values.delete(key);
    },
  };
  const user = { id: "owner", shop: { id: "shop" } };
  const scope = scopeFor("https://erp.test", user.id, user.shop.id);
  await store.put(scope + ":replica:v1", {
    views: { "/auth/me": user },
    acknowledged: [],
    at: new Date().toISOString(),
    businessVersion: "v1",
  });
  let version = "v1";
  const activity: boolean[] = [];
  const engine = new SyncEngine(
    store,
    scope,
    async <T>(route: string) => {
      if (route === "/auth/me") return user as T;
      if (route === "/mobile/offline-version") return { version } as T;
      if (route === "/mobile/offline-bootstrap")
        return {
          views: { "/auth/me": user },
          at: new Date().toISOString(),
          version: 1,
          businessVersion: version,
        } as T;
      throw new Error("Unexpected request");
    },
    { localFirst: true },
  );
  engine.subscribe(() => activity.push(Boolean(engine.status.transferring)));
  await engine.sync(true);
  await engine.sync(true);
  assert(
    !activity.includes(true),
    "Unchanged background checks must not show transfer status",
  );
  version = "v2";
  await engine.sync(true);
  assert(
    activity.includes(true),
    "Downloading changed data must show transfer status",
  );
  assert.equal(engine.status.transferring, false);
  engine.stop();
});
