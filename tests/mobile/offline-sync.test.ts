import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  sqliteStore,
  type SqlDatabase,
} from "../../apps/mobile/src/lib/offline/sqlite-store";
import {
  SyncEngine,
  scopeFor,
  type Send,
} from "../../apps/mobile/src/lib/offline/engine";
import { ApiError, ConnectionError } from "../../apps/mobile/src/lib/client";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const identity = { id: "rahim", shop: { id: "mirzaganj" }, permissions: [] };
const scope = scopeFor("https://erp.test", identity.id, identity.shop.id);
const body = {
  customerId: "customer-1",
  items: [{ productId: "battery-1", quantity: 2, unitPrice: "150.00" }],
  paidAmount: "100.00",
};
async function database() {
  const dir = mkdtempSync(join(tmpdir(), "hawlader-mobile-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  function open() {
    const db = new DatabaseSync(join(dir, "local.db"));
    let closed = false;
    const close = () => {
      if (!closed) {
        db.close();
        closed = true;
      }
    };
    cleanup.push(close);
    const adapter: SqlDatabase = {
      async execAsync(sql) {
        db.exec(sql);
      },
      async runAsync(sql, ...params) {
        return db.prepare(sql).run(...params);
      },
      async getFirstAsync<T>(sql: string, ...params: string[]) {
        return (db.prepare(sql).get(...params) as T) ?? null;
      },
      async getAllAsync<T>(sql: string, ...params: string[]) {
        return db.prepare(sql).all(...params) as T[];
      },
    };
    return { store: sqliteStore(adapter), close };
  }
  return open;
}
const transport = (
  fn: (
    route: string,
    options?: { method?: string; body?: unknown; key?: string },
  ) => unknown | Promise<unknown>,
) => fn as Send;

test("successful reads don't republish unchanged native sync status", async () => {
  const open = await database();
  const db = open();
  let online = true;
  const engine = new SyncEngine(
    await db.store,
    scope,
    transport(() => {
      if (!online) throw new ConnectionError("offline");
      return { items: [] };
    }),
  );
  let updates = 0;
  engine.subscribe(() => updates++);
  await engine.read("/products");
  await engine.read("/products");
  assert.equal(updates, 0);
  online = false;
  await engine.read("/products");
  await engine.read("/products");
  assert.equal(updates, 1);
  assert.equal(engine.status.offline, true);
  online = true;
  await engine.read("/products");
  assert.equal(updates, 2);
  assert.equal(engine.status.offline, false);
});

test("real SQLite persists cached pages across restart and isolates server/shop/user scopes", async () => {
  const open = await database();
  const first = open();
  const engine = new SyncEngine(
    await first.store,
    scope,
    transport(() => {
      throw new ConnectionError("offline");
    }),
  );
  await engine.remember("/products?page=1&pageSize=20&q=", {
    items: [{ id: "battery-1", stock: 12 }],
  });
  await engine.submit("/sales/complete", body, randomUUID());
  first.close();
  const second = open();
  const restored = new SyncEngine(
    await second.store,
    scope,
    transport(() => {
      throw new ConnectionError("offline");
    }),
  );
  assert.equal((await restored.commands()).length, 1);
  assert.deepEqual((await restored.read("/products?pageSize=20&page=1")).data, {
    items: [{ id: "battery-1", stock: 12 }],
  });
  assert.equal(
    (await restored.read("/products?pageSize=20&page=1")).stale,
    true,
  );
  for (const other of [
    scopeFor("https://erp.test", "brother", "mirzaganj"),
    scopeFor("https://erp.test", "rahim", "betagi"),
    scopeFor("https://other.test", "rahim", "mirzaganj"),
  ]) {
    const isolated = new SyncEngine(
      await second.store,
      other,
      transport(() => {
        throw new ConnectionError("offline");
      }),
    );
    await assert.rejects(
      isolated.read("/products?page=1&pageSize=20"),
      /not been downloaded/,
    );
    assert.equal((await isolated.commands()).length, 0);
  }
});

test("offline posting survives process restart and lost responses without a duplicate server transaction", async () => {
  const open = await database();
  const first = open();
  const id = randomUUID();
  const offline = new SyncEngine(
    await first.store,
    scope,
    transport(() => {
      throw new ConnectionError("offline");
    }),
  );
  assert.deepEqual(await offline.submit("/sales/complete", body, id), {
    queued: true,
    id,
  });
  assert.equal(offline.status.pending, 1);
  first.close();
  const receipts = new Map<string, unknown>();
  let posted = 0;
  let lost = true;
  const second = open();
  const online = new SyncEngine(
    await second.store,
    scope,
    transport((route, options) => {
      if (route === "/auth/me") return identity;
      assert.equal(options?.key, id);
      assert.deepEqual(options?.body, body);
      if (!receipts.has(id)) {
        posted++;
        receipts.set(id, { invoiceNumber: "HB-0001" });
      }
      if (lost) {
        lost = false;
        throw new ConnectionError("response lost after server commit");
      }
      return receipts.get(id);
    }),
  );
  await online.sync();
  assert.equal(online.status.pending, 1);
  await Promise.all([online.sync(), online.sync(), online.sync()]);
  assert.equal(posted, 1);
  assert.equal(online.status.pending, 0);
  assert.deepEqual(await online.submit("/sales/complete", body, id), {
    queued: false,
    data: { invoiceNumber: "HB-0001" },
  });
  await assert.rejects(
    online.submit("/sales/complete", { ...body, paidAmount: "200.00" }, id),
    /already saved/,
  );
});

test("stock conflicts pause the queue, preserve the rejected entry and allow an explicit retry", async () => {
  const open = await database();
  const db = open();
  let conflict = true;
  const calls: string[] = [];
  const engine = new SyncEngine(
    await db.store,
    scope,
    transport((route, options) => {
      if (route === "/auth/me") return identity;
      calls.push(options!.key!);
      if (conflict) throw new ApiError(409, "Insufficient available stock.");
      return { invoiceNumber: "HB-0002" };
    }),
  );
  const first = randomUUID();
  const second = randomUUID();
  await engine.submit("/sales/complete", body, first);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await engine.submit("/sales/complete", body, second);
  assert.equal(engine.status.blocked, 1);
  assert.equal(engine.status.pending, 1);
  assert.deepEqual(calls, [first]);
  await assert.rejects(
    engine.discardRejected(second),
    /Only a server-rejected/,
  );
  conflict = false;
  await engine.retry(first);
  assert.deepEqual(calls, [first, first, second]);
  assert.equal((await engine.commands()).length, 0);
});

test("401, permissions, and a changed shop cannot replay writes or fall back to cached protected pages", async () => {
  const open = await database();
  const db = open();
  let send: Send = transport(() => {
    throw new ConnectionError("offline");
  });
  const engine = new SyncEngine(await db.store, scope, (route, options) =>
    send(route, options),
  );
  await engine.remember("/sales", { items: ["private"] });
  await engine.submit("/sales/complete", body, randomUUID());
  let writes = 0;
  send = transport((route) => {
    if (route === "/auth/me") throw new ApiError(401, "Session expired.");
    writes++;
  });
  await engine.sync();
  assert.equal(writes, 0);
  assert.equal(engine.status.pending, 1);
  send = transport((route) => {
    if (route === "/auth/me") return { ...identity, shop: { id: "betagi" } };
    writes++;
  });
  await engine.sync();
  assert.equal(writes, 0);
  send = transport(() => {
    throw new ApiError(403, "Access removed.");
  });
  await assert.rejects(engine.read("/sales"), /Access removed/);
  assert.equal(await engine.cached("/sales"), null);
  await assert.rejects(
    engine.submit(
      "/auth/change-password",
      { password: "secret" },
      randomUUID(),
    ),
    /online connection/,
  );
  assert.equal((await engine.commands()).length, 1);
});

test("offline purchases, expenses and collections are durable, while non-replayable edits stay online", async () => {
  const open = await database();
  const db = open();
  let posts = 0;
  const engine = new SyncEngine(
    await db.store,
    scope,
    transport((route) => {
      if (route === "/auth/me") return identity;
      posts++;
      return { saved: true };
    }),
  );
  engine.network(false);
  for (const route of [
    "/purchases/receive",
    "/expenses",
    "/customers/customer-1/payments",
  ]) {
    const id = randomUUID();
    assert.deepEqual(await engine.submit(route, { amount: "0.10" }, id), {
      queued: true,
      id,
    });
  }
  assert.equal(posts, 0);
  assert.equal(engine.status.pending, 3);
  for (const route of [
    "/settings/shop",
    "/customers",
    "/suppliers",
    "/products",
    "/replacements/intake",
  ])
    await assert.rejects(
      engine.submit(route, {}, randomUUID()),
      /online connection/,
    );
  engine.network(true);
  await engine.sync();
  assert.equal(posts, 3);
  assert.equal(engine.status.pending, 0);
  const restarted = new SyncEngine(
    await db.store,
    scope,
    transport(() => identity),
  );
  await restarted.restoreStatus();
  assert.equal(restarted.status.lastSync, engine.status.lastSync);
});

test("a failed local write never reports a transaction as safely queued or sends it", async () => {
  const open = await database();
  const db = open();
  const store = await db.store;
  let sent = false;
  const engine = new SyncEngine(
    {
      ...store,
      async insert() {
        throw new Error("Disk is full.");
      },
    },
    scope,
    transport(() => {
      sent = true;
    }),
  );
  await assert.rejects(
    engine.submit("/expenses", { amount: "25.00" }, randomUUID()),
    /Disk is full/,
  );
  assert.equal(sent, false);
  assert.equal((await engine.commands()).length, 0);
});

test("a transaction saved during an existing background download is posted before reporting its result", async () => {
  const open = await database();
  const db = open();
  let release!: () => void, entered!: () => void;
  const downloading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const engine = new SyncEngine(
    await db.store,
    scope,
    transport(async (route, options) => {
      if (route === "/auth/me")
        return { ...identity, permissions: ["dashboard.read"] };
      if (options?.method === "POST") {
        posts++;
        return { id: "posted-expense" };
      }
      if (route === "/dashboard") {
        entered();
        await wait;
        return { total: "0.00" };
      }
      return { items: [], total: 0 };
    }),
  );
  const background = engine.sync(true);
  await downloading;
  const submission = engine.submit<{ id: string }>(
    "/expenses",
    { amount: "75.25" },
    randomUUID(),
  );
  while ((await engine.commands()).length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  release();
  await background;
  assert.deepEqual(await submission, {
    queued: false,
    data: { id: "posted-expense" },
  });
  assert.equal(posts, 1);
  assert.equal(engine.status.pending, 0);
});
