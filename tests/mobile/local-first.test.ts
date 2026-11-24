import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine, scopeFor } from "../../apps/mobile/src/lib/offline/engine";
import {
  sqliteStore,
  type SqlDatabase,
} from "../../apps/mobile/src/lib/offline/sqlite-store";
import {
  type ReplicaSnapshot,
  obj,
} from "../../apps/mobile/src/lib/offline/replica";
import {
  ConnectionError,
  type CurrentUser,
} from "../../apps/mobile/src/lib/client";
import {
  passwordVerifier,
  matchesPassword,
} from "../../apps/mobile/src/lib/offline/password";
import {
  enrollCredential,
  unlockCredential,
} from "../../apps/mobile/src/lib/offline/credentials";

const productId = randomUUID(),
  customerId = randomUUID(),
  supplierId = randomUUID(),
  typeId = randomUUID();
const user = {
  id: randomUUID(),
  shop: { id: randomUUID() },
  permissions: [
    "sales.manage",
    "purchases.manage",
    "inventory.read",
    "finance.read",
    "finance.write",
    "parties.customers",
    "parties.suppliers",
    "catalog.write",
    "payments.customer",
  ],
} as CurrentUser;
const scope = scopeFor("https://erp.test", user.id, user.shop!.id);
const prefix = scope + ":replica:v1";
test("returning device can prepare its own replica without waiting for the server", async () => {
  const database = open(":memory:");
  const store = await database.store;
  let requests = 0;
  const engine = new SyncEngine(store, scope, async () => {
    requests++;
    throw new ConnectionError("Server unavailable");
  }, { localFirst: true });
  try {
    assert.equal(await engine.hasReplica(), false);
    await store.put(prefix, snapshot());
    assert.equal(await engine.hasReplica(), true);
    await engine.restoreStatus();
    const products = await engine.read<{ items: unknown[] }>("/products");
    assert.equal(products.data.items.length, 1);
    assert.equal(requests, 0);
    const other = new SyncEngine(store, scopeFor("https://erp.test", "other", user.shop!.id), async () => { throw new Error("No request"); });
    assert.equal(await other.hasReplica(), false);
    other.stop();
  } finally { engine.stop(); database.close(); }
});
function snapshot(): ReplicaSnapshot {
  const product = {
    id: productId,
    name: "Motor",
    model: "M",
    unit: "pcs",
    active: true,
    type: { id: typeId, name: "Parts", trackingKind: "QUANTITY" },
    stock: { available: "10", total: "10" },
  };
  const customer = {
    id: customerId,
    name: "Customer",
    phone: "01700000001",
    address: "Betagi",
    active: true,
    due: "0.00",
    totalSales: "0.00",
  };
  const supplier = {
    id: supplierId,
    name: "Supplier",
    phone: "01800000001",
    active: true,
    due: "0.00",
  };
  return {
    at: new Date().toISOString(),
    acknowledged: [],
    views: {
      "/auth/me": user,
      "/products": { items: [product], total: 1 },
      "/customers": { items: [customer], total: 1 },
      "/suppliers": { items: [supplier], total: 1 },
      "/sales": { items: [], total: 0 },
      "/purchases": { items: [], total: 0 },
      "/expenses": { items: [], total: 0 },
      "/sales/options": {
        products: [{ ...product, availableQuantity: "10" }],
        customers: [customer],
        paymentAccounts: [],
      },
      "/purchases/options": { products: [product], suppliers: [supplier] },
      "/catalog": { types: [product.type], categories: [] },
      "/mobile/facts": {
        batches: [
          {
            id: randomUUID(),
            productId,
            date: "2026-01-01",
            unitCost: "5.30",
            quantity: 10,
          },
        ],
        cash: [],
      },
      "/dashboard": {
        counts: { products: 1, customers: 1, availableStock: "10" },
        stock: { batteriesAvailable: 0, partsAvailable: "10" },
        salesTrend: [],
        financials: {
          todaySales: "0.00",
          grossProfit: "0.00",
          customerDues: "0.00",
          supplierDues: "0.00",
          salesIncome: "0.00",
          salesProfit: "0.00",
          availableStockPurchaseValue: "53.00",
        },
        recentSales: [],
        lowStock: [],
      },
    },
  };
}
function open(file: string) {
  const db = new DatabaseSync(file);
  const adapter: SqlDatabase = {
    async execAsync(s) {
      db.exec(s);
    },
    async runAsync(s, ...p) {
      return db.prepare(s).run(...p);
    },
    async getFirstAsync<T>(s: string, ...p: string[]) {
      return (db.prepare(s).get(...p) as T) ?? null;
    },
    async getAllAsync<T>(s: string, ...p: string[]) {
      return db.prepare(s).all(...p) as T[];
    },
  };
  return { store: sqliteStore(adapter), close: () => db.close() };
}
const sale = (quantity = 1) => ({
  customerId,
  saleDate: "2026-11-23",
  items: [{ productId, quantity, unitPrice: "10.00" }],
  paidAmount: "5.00",
  notes: "Handle with care\nDeliver after 5 PM",
});

test("local sale commits, updates stock/dues/dashboard without a network read and survives SQLite restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawlader-local-first-")),
    file = join(dir, "device.db");
  let database = open(file),
    engine: SyncEngine | undefined;
  try {
    const store = await database.store;
    await store.put(prefix, snapshot());
    let calls = 0;
    const send = async <T>() => {
      calls++;
      throw new ConnectionError("offline");
      return null as T;
    };
    engine = new SyncEngine(store, scope, send, { localFirst: true });
    engine.network(false);
    await engine.read("/products?page=1&pageSize=10&q=Motor");
    const id = randomUUID(),
      result = await engine.submit<Record<string, unknown>>(
        "/sales/complete",
        sale(),
        id,
      );
    assert(!result.queued);
    assert.match(String(result.data.invoiceNumber), /^OFF-/);
    const duplicate = await engine.submit("/sales/complete", sale(), id);
    assert.deepEqual(duplicate, result);
    const products = await engine.read<{
      items: { stock: { available: string } }[];
    }>("/products?page=1&pageSize=10&q=Motor");
    assert.equal(products.data.items[0].stock.available, "9");
    const dashboard = await engine.read<{
      financials: {
        todaySales: string;
        grossProfit: string;
        customerDues: string;
        availableStockPurchaseValue: string;
      };
    }>("/dashboard?from=2026-11-23&to=2026-11-23");
    assert.equal(dashboard.data.financials.todaySales, "10.00");
    assert.equal(dashboard.data.financials.customerDues, "5.00");
    assert.equal(dashboard.data.financials.grossProfit, "4.70");
    assert.equal(
      dashboard.data.financials.availableStockPurchaseValue,
      "47.70",
    );
    assert.equal(calls, 0);
    engine.stop();
    database.close();
    database = open(file);
    engine = new SyncEngine(await database.store, scope, send, {
      localFirst: true,
    });
    engine.network(false);
    const sales = await engine.read<{ items: unknown[] }>(
      "/sales?page=1&pageSize=20",
    );
    assert.equal(sales.data.items.length, 1);
    const history = await engine.read<{items:{notes:string}[]}>(`/customers/${customerId}/sales`);
    assert.equal(history.data.items[0].notes, "Handle with care\nDeliver after 5 PM");
    await assert.rejects(
      () => engine!.submit("/sales/complete", sale(99), randomUUID()),
      /Not enough stock/,
    );
    assert.equal((await engine.commands()).length, 1);
  } finally {
    engine?.stop();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline new customer, product, purchase, sale and collection compose over local records", async () => {
  const database = open(":memory:"),
    store = await database.store;
  await store.put(prefix, snapshot());
  const engine = new SyncEngine(
    store,
    scope,
    async () => {
      throw new ConnectionError("offline");
    },
    { localFirst: true },
  );
  engine.network(false);
  try {
    const contact = randomUUID(),
      product = randomUUID();
    await engine.submit(
      "/customers",
      { name: "New offline", phone: "01900000001", address: "Betagi" },
      contact,
    );
    await engine.submit(
      "/products",
      {
        name: "Offline part",
        typeId,
        category: "Motor",
        unit: "pcs",
        defaultSellingPrice: "20.00",
      },
      product,
    );
    await engine.submit(
      "/purchases/receive",
      {
        supplierId,
        purchaseDate: "2026-11-23",
        reference: "Challan 1",
        items: [{ productId: product, quantity: 3, unitPrice: "12.00" }],
        paidAmount: "0.00",
      },
      randomUUID(),
    );
    await engine.submit(
      "/sales/complete",
      {
        customerId: contact,
        saleDate: "2026-11-23",
        items: [{ productId: product, quantity: 1, unitPrice: "20.00" }],
        paidAmount: "0.00",
      },
      randomUUID(),
    );
    await engine.submit(
      `/customers/${contact}/payments`,
      { date: "2026-11-23", amount: "7.00", paymentAccountId: randomUUID() },
      randomUUID(),
    );
    const customers = await engine.read<{
      items: { id: string; due: string }[];
    }>("/customers");
    assert.equal(
      customers.data.items.find((c) => c.id === contact)?.due,
      "13.00",
    );
    const history = await engine.read<{
      items: { paid: string; due: string }[];
    }>(`/customers/${contact}/sales`);
    assert.equal(history.data.items[0].paid, "7.00");
    assert.equal(history.data.items[0].due, "13.00");
    const products = await engine.read<{
      items: { id: string; stock: { available: string } }[];
    }>("/products");
    assert.equal(
      products.data.items.find((p) => p.id === product)?.stock.available,
      "2",
    );
    const dashboard = await engine.read<{
      financials: {
        grossProfit: string;
        supplierDues: string;
        todayCashReceived: string;
      };
    }>("/dashboard?from=2026-11-23&to=2026-11-23");
    assert.equal(dashboard.data.financials.grossProfit, "8.00");
    assert.equal(dashboard.data.financials.supplierDues, "36.00");
    assert.equal(dashboard.data.financials.todayCashReceived, "7.00");
  } finally {
    engine.stop();
    database.close();
  }
});

test("lost cloud response retries one operation and atomically replaces its local overlay after acknowledgement", async () => {
  const database = open(":memory:"),
    store = await database.store;
  let base = snapshot();
  await store.put(prefix, base);
  let commits = 0,
    attempts = 0;
  const receipts = new Map<string, unknown>();
  const engine = new SyncEngine(
    store,
    scope,
    async <T>(route: string, options = {}) => {
      const key = (options as { key?: string }).key || "";
      if (route === "/auth/me") return user as T;
      if (route === "/sales/complete") {
        attempts++;
        if (receipts.has(key)) return receipts.get(key) as T;
        commits++;
        const result = {
          id: randomUUID(),
          invoiceNumber: "HWB-000123",
          customerId,
          total: "10.00",
          subtotal: "10.00",
          paid: "5.00",
          due: "5.00",
          quantity: 1,
        };
        receipts.set(key, result);
        const product = obj(base.views["/products"]);
        obj((product.items as unknown[])[0]).stock = {
          available: "9",
          total: "9",
        };
        base.views["/sales"] = {
          items: [
            {
              ...result,
              saleDate: "2026-11-23",
              customer: { id: customerId, name: "Customer" },
            },
          ],
          total: 1,
        };
        throw new ConnectionError("response lost after commit");
      }
      if (route === "/mobile/offline-bootstrap")
        return {
          views: base.views,
          at: new Date().toISOString(),
          version: 1,
          businessVersion: "1",
        } as T;
      throw new Error("Unexpected route " + route);
    },
    { localFirst: true },
  );
  try {
    engine.network(false);
    await engine.submit("/sales/complete", sale(), randomUUID());
    await engine.sync();
    engine.network(true);
    await engine.sync(true);
    assert.equal((await engine.commands()).length, 1);
    await engine.sync(true);
    assert.equal((await engine.commands()).length, 0);
    assert.equal(commits, 1);
    assert.equal(attempts, 2);
    const products = await engine.read<{
      items: { stock: { available: string } }[];
    }>("/products");
    assert.equal(products.data.items[0].stock.available, "9");
    const sales = await engine.read<{ items: { invoiceNumber: string }[] }>(
      "/sales",
    );
    assert.equal(sales.data.items[0].invoiceNumber, "HWB-000123");
    const saved = await store.get<ReplicaSnapshot>(prefix);
    assert.equal(saved?.acknowledged.length, 1);
    base = snapshot();
  } finally {
    engine.stop();
    database.close();
  }
});

test("offline password verifier is salted, rejects an incorrect password and stores no plaintext", async () => {
  const salt = new Uint8Array(32).fill(11),
    verifier = await passwordVerifier("Device-739152", salt);
  assert(!JSON.stringify(verifier).includes("Device-739152"));
  assert(await matchesPassword("Device-739152", verifier));
  assert(!(await matchesPassword("wrong", verifier)));
  const second = await passwordVerifier(
    "Device-739152",
    new Uint8Array(32).fill(12),
  );
  assert.notDeepEqual(verifier.hash, second.hash);
});

test("enrolled device logs in with no network after logout/restart and rejects another account or origin", async () => {
  const values = new Map<string, string>(),
    storage = {
      get: async (k: string) => values.get(k) ?? null,
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
    };
  const account = { ...user, login: "owner@example.com" },
    session = {
      origin: "https://erp.test",
      accessToken: "ab".repeat(32),
      expiresAt: "2020-01-01T00:00:00Z",
      userId: user.id,
      shopId: user.shop!.id,
    };
  await enrollCredential(
    storage,
    new Uint8Array(32).fill(25),
    session.origin,
    account.login,
    "Offline-654321",
    session,
    account,
  );
  assert(![...values.values()].join("").includes("Offline-654321"));
  const restored = { get: storage.get, set: storage.set };
  await assert.rejects(
    () => unlockCredential(restored, session.origin, account.login, "wrong"),
    /Incorrect/,
  );
  assert.equal(
    await unlockCredential(
      restored,
      "https://other.test",
      account.login,
      "Offline-654321",
    ),
    null,
  );
  assert.equal(
    await unlockCredential(
      restored,
      session.origin,
      "someone@example.com",
      "Offline-654321",
    ),
    null,
  );
  const result = await unlockCredential(
    restored,
    session.origin,
    "OWNER@example.com",
    "Offline-654321",
  );
  assert.equal(result?.user.id, user.id);
  assert.equal(result?.failures, 0);
});

test("unchanged data keeps the fast local cache; a changed server version atomically refreshes it",async()=>{
  const database=open(":memory:"),store=await database.store,base=snapshot();base.businessVersion="v1";await store.put(prefix,base);
  let version="v1",downloads=0;
  const engine=new SyncEngine(store,scope,async<T,>(route: string)=>{
    if(route==="/auth/me")return user as T;
    if(route==="/mobile/offline-version")return {version} as T;
    if(route==="/mobile/offline-bootstrap"){
      downloads++;const next=snapshot();obj((obj(next.views["/products"]).items as unknown[])[0]).stock={available:"8",total:"8"};return {views:next.views,at:new Date().toISOString(),version:1,businessVersion:version} as T;
    }
    throw Error("Unexpected request");
  },{localFirst:true});
  try{
    const before=await engine.read<{items:{stock:{available:string}}[]}>("/products");assert.equal(before.data.items[0].stock.available,"10");
    await engine.sync(true);assert.equal(downloads,0);
    version="v2";await engine.sync(true);assert.equal(downloads,1);
    const after=await engine.read<{items:{stock:{available:string}}[]}>("/products");assert.equal(after.data.items[0].stock.available,"8");
  }finally{engine.stop();database.close();}
});

test("a local storage failure never claims a committed sale or changes stock",async()=>{
  const database=open(":memory:"),store=await database.store;await store.put(prefix,snapshot());let requests=0;
  const broken={...store,put:async(key:string,value:unknown)=>{if(key.includes(":outbox:"))throw Error("Disk full");return store.put(key,value);}};
  const engine=new SyncEngine(broken,scope,async()=>{requests++;throw Error("Must not send");},{localFirst:true});engine.network(false);
  try{
    await assert.rejects(()=>engine.submit("/sales/complete",sale(),randomUUID()),/Disk full/);
    const items=await engine.read<{items:{stock:{available:string}}[]}>("/products");assert.equal(items.data.items[0].stock.available,"10");assert.equal(requests,0);assert.equal((await engine.commands()).length,0);
  }finally{engine.stop();database.close();}
});

test("device clock changes cannot reorder dependent offline writes", async () => {
  const database = open(":memory:"), store = await database.store;
  await store.put(prefix, snapshot());
  const engine = new SyncEngine(store, scope, async () => { throw new ConnectionError("offline"); }, {localFirst:true});
  engine.network(false);
  try {
    const first = "ffffffff-ffff-4fff-8fff-ffffffffffff", second = "00000000-0000-4000-8000-000000000001";
    await engine.submit("/sales/complete", sale(), first);
    const key=scope+":outbox:"+first;
    const saved=await store.get<Record<string,unknown>>(key);
    await store.put(key,{...saved,createdAt:"2099-01-01T00:00:00.000Z"});
    await engine.submit("/customers", {name:"New customer",phone:"01700000002",address:"Betagi"}, second);
    assert.deepEqual((await engine.commands()).map(c=>c.id),[first,second]);
  } finally { engine.stop(); database.close(); }
});

test("shop name and tag line save offline, survive restart, and allow clearing the tag line", async () => {
  const database = open(":memory:");
  const store = await database.store;
  const initial = snapshot();
  initial.views["/auth/me"] = { ...user, permissions: [...user.permissions, "settings.manage"] };
  initial.views["/settings/shop"] = { value: { name: "Original", address: "", phone: "" }, version: 1 };
  await store.put(prefix, initial);
  let engine = new SyncEngine(store, scope, async () => { throw new ConnectionError("offline"); }, { localFirst: true });
  engine.network(false);
  try {
    await engine.submit("/settings/shop", { name: "New Shop", tagLine: "  Batteries and Parts  ", tagLine2: "  " + "Authorized dealer ".repeat(40).trim() + "  ", address: "", phone: "", version: 1 }, randomUUID());
    const profile = await engine.read<{name: string; tagLine: string}>("/shop-profile");
    assert.equal(profile.data.name, "New Shop");
    assert.equal(profile.data.tagLine, "Batteries and Parts");
    assert.equal((await engine.read<{tagLine2: string}>("/shop-profile")).data.tagLine2, "Authorized dealer ".repeat(40).trim());
    engine.stop();
    engine = new SyncEngine(store, scope, async () => { throw new ConnectionError("offline"); }, { localFirst: true });
    engine.network(false);
    assert.equal((await engine.read<{tagLine: string}>("/shop-profile")).data.tagLine, "Batteries and Parts");
    await assert.rejects(engine.submit("/settings/shop", {name: "New Shop", tagLine: "x".repeat(1001), address: "", phone: "", version: 2}, randomUUID()), /valid shop details/);
    await engine.submit("/settings/shop", {name: "New Shop", tagLine: "", address: "", phone: "", version: 2}, randomUUID());
    assert.equal((await engine.read<{tagLine: string}>("/shop-profile")).data.tagLine, "");
    assert.equal((await engine.read<{tagLine2: string}>("/shop-profile")).data.tagLine2, "Authorized dealer ".repeat(40).trim());
    await engine.submit("/settings/shop", {name: "New Shop", tagLine: "", tagLine2: "", address: "", phone: "", version: 3}, randomUUID());
    assert.equal((await engine.read<{tagLine2: string}>("/shop-profile")).data.tagLine2, "");
  } finally { engine.stop(); database.close(); }
});
