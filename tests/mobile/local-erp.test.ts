import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  amount,
  LocalErp,
  LocalErpError,
  money,
  restoreNewLocalShop,
  sqliteErpStore,
  sqliteDriveReplicaStore,
  validateLocalState,
  warrantyExpiry,
  type LocalErpStore,
} from "../../packages/local-erp/src";
import {
  DriveReplica,
  DriveSyncError,
  decryptSnapshot,
  newShopEncryptionKey,
  webSnapshotCrypto,
  type DriveWrite,
  type DrivePairing,
  type DriveHead,
} from "../../packages/drive-sync/src";
import { LocalDevice } from "../../packages/local-erp/src/device";
import { LocalWorkspaceApi } from "../../packages/local-erp/src/workspace-api";
import type {
  CustomerLedger,
  CustomerSalesHistory,
  PurchaseOptions,
  DashboardData,
  ExpenseList,
} from "../../packages/api-client/src";
import {
  fromBase64,
  toBase64,
  utf8,
  fromUtf8,
} from "../../packages/drive-sync/src/bytes";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const permissions = [
  "catalog.write",
  "parties.customers",
  "parties.suppliers",
  "purchases.manage",
  "sales.manage",
  "finance.read",
  "replacements.intake.stock",
  "replacements.intake.customer",
  "replacements.dispatch",
  "replacements.receive",
  "replacements.deliver",
  "replacements.resolve",
  "transactions.reverse",
];
async function fixture() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "howlader-local-erp-test-"),
  );
  cleanup.push(() => {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("howlader-local-erp-test-")
    )
      throw new Error("Unexpected test cleanup path.");
    rmSync(resolved, { recursive: true, force: true });
  });
  const shopId = randomUUID(),
    actor = { id: randomUUID(), permissions };
  async function open(filename = "local.db") {
    const db = new DatabaseSync(path.join(directory, filename));
    let closed = false;
    const close = () => {
      if (!closed) {
        db.close();
        closed = true;
      }
    };
    cleanup.push(close);
    const database = {
      async execAsync(sql: string) {
        db.exec(sql);
      },
      async getFirstAsync<T>(
        sql: string,
        ...params: string[]
      ): Promise<T | null> {
        return (db.prepare(sql).get(...params) as T) ?? null;
      },
    };
    const store = await sqliteErpStore(database);
    return {
      engine: new LocalErp(store, shopId, actor),
      store,
      close,
      database,
    };
  }
  const connection = await open();
  const category = await connection.engine.createCategory(randomUUID(), {
    name: "Parts",
    trackingKind: "QUANTITY",
  });
  const supplier = await connection.engine.createContact(randomUUID(), {
    kind: "supplier",
    name: "Supplier",
    phone: "01700000001",
    categoryId: category.id,
  });
  const customer = await connection.engine.createContact(randomUUID(), {
    kind: "customer",
    name: "Customer",
    phone: "01700000002",
  });
  const product = await connection.engine.createProduct(randomUUID(), {
    categoryId: category.id,
    name: "Motor",
  });
  return {
    ...connection,
    open,
    shopId,
    actor,
    category,
    supplier,
    customer,
    product,
  };
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof LocalErpError && error.code === code,
  );

test("authenticated device blocks posting before restore, flushes an in-flight commit before handoff, and preserves expired account data", async () => {
  const f = await fixture(),
    drive = mockDrive(),
    pairing = replicaIdentity(f.shopId);
  const shopKey = newShopEncryptionKey();
  const grant = {
    pairing,
    shopKey,
    expiresAt: Date.now() + 86400000,
    user: {
      id: f.actor.id,
      email: "owner@example.test",
      name: "Owner",
      shop: { id: f.shopId, name: "Test shop", branchName: "Test" },
    },
  };
  let disconnected = true;
  const send: typeof fetch = async (_url, init) => {
    if (disconnected) throw new Error("Network unavailable");
    const input = JSON.parse(String(init?.body));
    assert.equal(input.token, pairing.token);
    const data =
      input.op === "claim"
        ? await drive.transport.claim()
        : input.op === "pull"
          ? await drive.transport.pull()
          : input.op === "push"
            ? await drive.transport.push(input)
            : await drive.transport.release();
    return new Response(JSON.stringify({ ok: true, data }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const runtime = new LocalDevice(
    grant,
    "https://script.google.com/macros/s/test/exec",
    f.store,
    await sqliteDriveReplicaStore(f.database, f.shopId),
    webSnapshotCrypto,
    send,
  );
  cleanup.push(() => runtime.stop());
  const expense = { date: "2026-11-22", description: "Rent", amount: "100" };
  await rejects(runtime.command("expense", randomUUID(), expense), "NOT_READY");
  await assert.rejects(runtime.open());
  assert.equal((await runtime.view()).ready, false);
  disconnected = false;
  await runtime.open();
  const posting = runtime.command("expense", randomUUID(), expense);
  await runtime.handoff();
  await posting;
  assert.equal((await runtime.view()).ready, false);
  await rejects(runtime.command("expense", randomUUID(), expense), "NOT_READY");
  const cloud = await decryptSnapshot<
    import("../../packages/local-erp/src").LocalErpState
  >(drive.current().payload, shopKey, pairing.serviceId, f.shopId);
  assert.equal(Object.values(cloud.expenses).length, 1);
  const expired = new LocalDevice(
    { ...grant, expiresAt: Date.now() - 1000 },
    "https://script.google.com/macros/s/test/exec",
    f.store,
    await sqliteDriveReplicaStore(f.database, f.shopId),
    webSnapshotCrypto,
    send,
  );
  cleanup.push(() => expired.stop());
  await expired.open();
  await rejects(
    expired.command("expense", randomUUID(), expense),
    "LOGIN_EXPIRED",
  );
  assert.equal(Object.values((await expired.view()).state.expenses).length, 1);
});

function mockDrive() {
  let head: DriveHead = { revision: 0 },
    payload = "",
    loseReply = false;
  const writes = new Map<string, { write: DriveWrite; revision: number }>();
  let duringPush: (() => Promise<void>) | undefined;
  const transport = {
    async claim() {
      return {
        leaseId: "test-lease",
        expiresAt: Date.now() + 180000,
        head: { ...head },
        shop: { id: "test", name: "Test" },
      };
    },
    async pull() {
      return { head: { ...head }, unchanged: false, payload };
    },
    async release() {
      return { released: true };
    },
    async push(write: DriveWrite) {
      const previous = writes.get(write.writeId);
      if (previous) {
        assert.equal(write.payload, previous.write.payload);
        return {
          revision: previous.revision,
          currentRevision: head.revision,
          writeId: write.writeId,
          repeated: true,
        };
      }
      if (write.baseRevision !== head.revision)
        throw new DriveSyncError("REVISION_CONFLICT", "Newer snapshot exists");
      head = {
        revision: head.revision + 1,
        writeId: write.writeId,
        payloadFormat: "a256gcm-v1",
        payloadHash: write.payloadHash,
      };
      payload = write.payload;
      writes.set(write.writeId, {
        write: structuredClone(write),
        revision: head.revision,
      });
      if (duringPush) {
        const update = duringPush;
        duringPush = undefined;
        await update();
      }
      if (loseReply) {
        loseReply = false;
        throw new DriveSyncError("NETWORK", "Lost upload acknowledgement");
      }
      return {
        revision: head.revision,
        currentRevision: head.revision,
        writeId: write.writeId,
        repeated: false,
      };
    },
  };
  return {
    transport,
    writes,
    loseNextReply: () => {
      loseReply = true;
    },
    updateDuringPush: (work: () => Promise<void>) => {
      duringPush = work;
    },
    current: () => ({ head, payload }),
  };
}
function replicaIdentity(shopId: string): DrivePairing {
  return {
    protocol: 1,
    serviceId: "service-test",
    shopId,
    shopName: "Test shop",
    deviceId: randomUUID(),
    deviceName: "Phone",
    token: "1".repeat(64),
  };
}
test("original ERP screen contracts post purchases, sales and collections locally and keep product names separate from stock", async () => {
  const f = await fixture(),
    drive = mockDrive(),
    pairing = replicaIdentity(f.shopId);
  const send: typeof fetch = async (_url, init) => {
    const b = JSON.parse(String(init?.body));
    const data =
      b.op === "claim"
        ? await drive.transport.claim()
        : b.op === "pull"
          ? await drive.transport.pull()
          : b.op === "push"
            ? await drive.transport.push(b)
            : await drive.transport.release();
    return new Response(JSON.stringify({ ok: true, data }));
  };
  const runtime = new LocalDevice(
    {
      pairing,
      shopKey: newShopEncryptionKey(),
      expiresAt: Date.now() + 86400000,
      user: {
        id: f.actor.id,
        email: "owner@example.test",
        name: "Owner",
        shop: { id: f.shopId, name: "Test", branchName: "Test" },
      },
    },
    "https://script.google.com/macros/s/test/exec",
    f.store,
    await sqliteDriveReplicaStore(f.database, f.shopId),
    webSnapshotCrypto,
    send,
  );
  cleanup.push(() => runtime.stop());
  await runtime.open();
  const api = new LocalWorkspaceApi(runtime);
  await api.request(
    "/categories",
    "POST",
    { typeId: f.category.id, name: "Gear box" },
    randomUUID(),
  );
  assert.equal(Object.values((await runtime.view()).state.products).length, 1);
  const options = (await api.request("/purchases/options")) as PurchaseOptions;
  assert.ok(options.productNames?.some((n) => n.name === "Gear box"));
  await api.request(
    "/purchases/receive",
    "POST",
    {
      supplierId: f.supplier.id,
      purchaseDate: "2026-11-22",
      reference: "C2",
      items: [{ productId: f.product.id, quantity: 2, unitPrice: "100" }],
      paidAmount: "50",
      transportAmount: "0",
    },
    randomUUID(),
  );
  await api.request(
    "/sales/complete",
    "POST",
    {
      customerId: f.customer.id,
      saleDate: "2026-11-22",
      notes: "Handle with care\nDeliver after 5 PM",
      items: [{ productId: f.product.id, quantity: 1, unitPrice: "150" }],
      paidAmount: "20",
    },
    randomUUID(),
  );
  await api.request(
    `/customers/${f.customer.id}/payments`,
    "POST",
    { date: "2026-11-22", amount: "30", paymentAccountId: "1100" },
    randomUUID(),
  );
  const ledger = (await api.request(
    `/customers/${f.customer.id}/ledger`,
  )) as CustomerLedger;
  assert.equal(ledger.summary.closing, "100.00");
  assert.equal(ledger.summary.credit, "50.00");
  assert.equal(ledger.items[0].kind, "payment");
  assert.equal(ledger.items[0].debit, "0.00");
  assert.equal(ledger.customer.due, "100.00");
  const history = (await api.request(
    `/customers/${f.customer.id}/sales`,
  )) as CustomerSalesHistory;
  assert.equal(history.items[0].products[0].model, "N/A");
  assert.equal(history.items[0].total, "150.00");
  assert.equal(history.items[0].notes, "Handle with care\nDeliver after 5 PM");
  await api.request(
    "/expenses",
    "POST",
    {
      expenseDate: "2026-11-22",
      category: "Office Expense",
      description: "Rent",
      amount: "5",
    },
    randomUUID(),
  );
  const expenses = (await api.request("/expenses")) as ExpenseList;
  assert.equal(expenses.items[0].category, "Office Expense");
  const dashboard = (await api.request(
    "/dashboard?from=2026-11-22&to=2026-11-22",
  )) as DashboardData;
  assert.equal(dashboard.financials?.customerDues, "100.00");
  assert.equal(dashboard.financials?.supplierDues, "150.00");
  assert.equal(dashboard.financials?.grossProfit, "50.00");
  const profile = (await api.request("/settings/shop")) as {
    value: { name: string; address: string; phone: string };
    version: number;
  };
  assert.equal(profile.value.name, "Howlader Battery House");
  assert.equal(profile.version, 0);
  const fields = {
    name: "Betagi Battery",
    tagLine: "Batteries and Auto Parts",
    tagLine2: "Authorized dealer ".repeat(40).trim(),
    address: "College Road",
    phone: "01712345678",
    version: 0,
  };
  const savedProfile = (await api.request(
    "/settings/shop",
    "POST",
    fields,
    randomUUID(),
  )) as typeof profile;
  assert.deepEqual(savedProfile, {
    value: {
      name: fields.name,
      tagLine: fields.tagLine,
      tagLine2: fields.tagLine2,
      address: fields.address,
      phone: fields.phone,
    },
    version: 1,
  });
  assert.deepEqual(await api.request("/shop-profile"), savedProfile.value);
  const afterProfile = await runtime.erp.snapshot();
  await rejects(
    api.request(
      "/settings/shop",
      "POST",
      { ...fields, name: "Stale overwrite" },
      randomUUID(),
    ),
    "VERSION_CONFLICT",
  );
  await rejects(
    api.request(
      "/settings/shop",
      "POST",
      { ...fields, name: "", version: 1 },
      randomUUID(),
    ),
    "INVALID_INPUT",
  );
  await rejects(
    f.engine.saveShopProfile(randomUUID(), { ...fields, version: 1 }),
    "ACCESS_DENIED",
  );
  assert.deepEqual(await runtime.erp.snapshot(), afterProfile);
  const reopened = await f.open();
  assert.deepEqual(
    (await reopened.engine.snapshot()).shopProfile,
    savedProfile,
  );
  await api.request("/backups/run", "POST", {});
  const decoded = await decryptSnapshot<
    import("../../packages/local-erp/src").LocalErpState
  >(
    drive.current().payload,
    runtime.grant.shopKey,
    pairing.serviceId,
    f.shopId,
  );
  assert.deepEqual(decoded.shopProfile, savedProfile);
  const before = await runtime.erp.snapshot();
  await assert.rejects(
    api.request("/sales/unknown", "DELETE"),
    /not connected/,
  );
  assert.deepEqual(await runtime.erp.snapshot(), before);
});
test("two online devices automatically serialize sales, refresh stock and replay a lost acknowledgement without handoff", async () => {
  const f = await fixture();
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: f.supplier.id,
    date: "2026-11-22",
    reference: "Stock",
    items: [{ productId: f.product.id, quantity: 5, unitPrice: "10" }],
    paid: "0",
  });
  const b = await f.open("second-online-device.db"),
    key = newShopEncryptionKey(),
    pairA = replicaIdentity(f.shopId),
    pairB = {
      ...pairA,
      deviceId: randomUUID(),
      deviceName: "Other phone",
      token: "2".repeat(64),
    };
  let head: DriveHead = { revision: 0 },
    payload = "",
    held: { device: string; id: string } | null = null,
    claims = 0,
    loseReply = false,
    disconnected = false;
  const writes = new Map<
    string,
    { revision: number; payload: string; device: string }
  >();
  const network: typeof fetch = async (_url, init) => {
    if (disconnected) throw new Error("Offline");
    const input = JSON.parse(String(init?.body)),
      device = input.token === pairA.token ? pairA.deviceId : pairB.deviceId;
    await Promise.resolve();
    try {
      let data: unknown;
      if (input.op === "claim") {
        if (held && held.device !== device)
          throw new DriveSyncError("DEVICE_BUSY", "Another save is running");
        held = { device, id: held?.id || randomUUID() };
        claims++;
        data = {
          leaseId: held.id,
          expiresAt: Date.now() + 180000,
          head: { ...head },
          shop: { id: f.shopId, name: "Test" },
        };
      } else if (input.op === "pull")
        data = {
          head: { ...head },
          unchanged: input.knownRevision === head.revision,
          ...(input.knownRevision === head.revision ? {} : { payload }),
        };
      else if (input.op === "release") {
        assert.equal(held?.device, device);
        assert.equal(held?.id, input.leaseId);
        held = null;
        data = { released: true };
      } else if (input.op === "push") {
        const previous = writes.get(input.writeId);
        if (previous) {
          assert.equal(previous.payload, input.payload);
          assert.equal(previous.device, device);
          data = {
            revision: previous.revision,
            currentRevision: head.revision,
            writeId: input.writeId,
            repeated: true,
          };
        } else {
          if (held?.device !== device || held.id !== input.leaseId)
            throw new DriveSyncError("LEASE_LOST", "No writer lease");
          if (input.baseRevision !== head.revision)
            throw new DriveSyncError("REVISION_CONFLICT", "Stale snapshot");
          assert.equal(
            input.payloadHash,
            createHash("sha256").update(input.payload).digest("hex"),
          );
          head = {
            revision: head.revision + 1,
            payloadHash: input.payloadHash,
            payloadFormat: input.payloadFormat,
          };
          payload = input.payload;
          writes.set(input.writeId, {
            revision: head.revision,
            payload,
            device,
          });
          if (loseReply) {
            loseReply = false;
            throw new Error("Lost committed response");
          }
          data = {
            revision: head.revision,
            currentRevision: head.revision,
            writeId: input.writeId,
            repeated: false,
          };
        }
      } else throw new Error("Unexpected cloud operation");
      return new Response(JSON.stringify({ ok: true, data }));
    } catch (e) {
      if (e instanceof DriveSyncError)
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: e.code, message: e.message },
          }),
        );
      throw e;
    }
  };
  const grant = (pairing: DrivePairing) => ({
    pairing,
    shopKey: key,
    expiresAt: Date.now() + 86400000,
    user: {
      id: f.actor.id,
      email: "owner@example.test",
      name: "Owner",
      shop: { id: f.shopId, name: "Test", branchName: "Test" },
    },
  });
  const a = new LocalDevice(
    grant(pairA),
    "https://script.google.com/macros/s/test/exec",
    f.store,
    await sqliteDriveReplicaStore(f.database, f.shopId),
    webSnapshotCrypto,
    network,
  );
  const phone = new LocalDevice(
    grant(pairB),
    "https://script.google.com/macros/s/test/exec",
    b.store,
    await sqliteDriveReplicaStore(b.database, f.shopId),
    webSnapshotCrypto,
    network,
  );
  cleanup.push(
    () => a.stop(),
    () => phone.stop(),
  );
  await a.open();
  await phone.open();
  assert.equal(held, null);
  const sale = {
    customerId: f.customer.id,
    date: "2026-11-22",
    items: [{ productId: f.product.id, quantity: 2, unitPrice: "20" }],
    paid: "0",
  };
  const results = (await Promise.all([
    a.command("sale", randomUUID(), sale),
    phone.command("sale", randomUUID(), sale),
  ])) as { invoiceNumber: string }[];
  assert.deepEqual(results.map((v) => v.invoiceNumber).sort(), [
    "HB-0001",
    "HB-0002",
  ]);
  assert.equal(held, null);
  const beforeRead = claims;
  await Promise.all([a.sync(), phone.sync()]);
  assert.equal(
    claims,
    beforeRead,
    "idle readers must not claim or retain writer leases",
  );
  assert.deepEqual(await a.erp.snapshot(), await phone.erp.snapshot());
  assert.equal(
    (await a.erp.snapshot()).batches.reduce((n, v) => n + v.available, 0),
    1,
  );
  const remaining = {
    ...sale,
    items: [{ productId: f.product.id, quantity: 1, unitPrice: "20" }],
  };
  const finalSales = await Promise.allSettled([
    a.command("sale", randomUUID(), remaining),
    phone.command("sale", randomUUID(), remaining),
  ]);
  assert.equal(finalSales.filter((v) => v.status === "fulfilled").length, 1);
  const rejected = finalSales.find(
    (v) => v.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "INSUFFICIENT_STOCK");
  assert.equal(held, null);
  const request = randomUUID(),
    expense = {
      date: "2026-11-22",
      amount: "5",
      description: "Lost acknowledgement",
    };
  loseReply = true;
  await assert.rejects(
    a.command("expense", request, expense),
    /Saved on this device/,
  );
  assert.equal(held, null);
  // The other device can save while the first still has an unacknowledged upload.
  await phone.command("expense", randomUUID(), {
    ...expense,
    description: "Other device work",
  });
  const committedRevision = head.revision;
  const replay = (await a.command("expense", request, expense)) as {
    id: string;
  };
  assert.equal(replay.id, request);
  assert.equal(head.revision, committedRevision);
  await phone.sync();
  const cloud = await decryptSnapshot<
    import("../../packages/local-erp/src").LocalErpState
  >(payload, key, pairA.serviceId, f.shopId);
  assert.equal(Object.keys(cloud.sales).length, 3);
  assert.equal(Object.keys(cloud.expenses).length, 2);
  assert.equal(cloud.batches[0].available, 0);
  assert.deepEqual(await a.erp.snapshot(), await phone.erp.snapshot());
  const beforeOffline = await a.erp.snapshot();
  disconnected = true;
  await assert.rejects(a.command("expense", randomUUID(), expense));
  assert.deepEqual(
    await a.erp.snapshot(),
    beforeOffline,
    "unconnected devices cannot confirm new work on a stale snapshot",
  );
});
async function makeReplica(
  f: Awaited<ReturnType<typeof fixture>>,
  drive: ReturnType<typeof mockDrive>,
  pairing: DrivePairing,
  key: string,
  connection = f,
) {
  const repository = await sqliteDriveReplicaStore(
    connection.database,
    f.shopId,
  );
  return new DriveReplica(
    repository,
    drive.transport,
    pairing,
    key,
    (value) => {
      const state = value as Awaited<ReturnType<typeof f.engine.snapshot>>;
      validateLocalState(state, f.shopId);
      return state;
    },
    (value) => value.sequence === 0,
  );
}

test("durable Drive sync retries a lost response after restart without creating another cloud revision", async () => {
  const f = await fixture(),
    drive = mockDrive(),
    pairing = replicaIdentity(f.shopId),
    key = newShopEncryptionKey();
  const replica = await makeReplica(f, drive, pairing, key);
  drive.loseNextReply();
  await assert.rejects(replica.sync(), DriveSyncError);
  assert.equal((await replica.status()).pending, true);
  assert.equal(drive.current().head.revision, 1);
  f.close();
  const reopened = await f.open();
  const next = await makeReplica(f, drive, pairing, key, { ...f, ...reopened });
  await next.sync();
  assert.equal(drive.writes.size, 1);
  assert.equal((await next.status()).pending, false);
  assert.equal((await next.status()).cloudRevision, 1);
});

test("a local commit during upload remains pending until its own revision is backed up", async () => {
  const f = await fixture(),
    drive = mockDrive(),
    pairing = replicaIdentity(f.shopId),
    key = newShopEncryptionKey();
  const replica = await makeReplica(f, drive, pairing, key);
  drive.updateDuringPush(async () => {
    await f.engine.recordExpense(randomUUID(), {
      date: "2026-11-22",
      amount: "25",
      description: "Local update during upload",
    });
  });
  await replica.sync();
  assert.equal(drive.current().head.revision, 2);
  assert.equal((await replica.status()).pending, false);
  const remote = await decryptSnapshot(
    drive.current().payload,
    key,
    pairing.serviceId,
    pairing.shopId,
  );
  assert.deepEqual(remote, await f.engine.snapshot());
});

test("a new device restores an encrypted snapshot, while dirty local data and wrong keys are preserved", async () => {
  const f = await fixture(),
    drive = mockDrive(),
    pairing = replicaIdentity(f.shopId),
    key = newShopEncryptionKey();
  const replica = await makeReplica(f, drive, pairing, key);
  await replica.sync();
  const fresh = await f.open("drive-new-device.db");
  const newPairing = {
    ...pairing,
    deviceId: randomUUID(),
    deviceName: "New PC",
  };
  const restored = await makeReplica(f, drive, newPairing, key, {
    ...f,
    ...fresh,
  });
  await restored.sync();
  assert.deepEqual(await fresh.engine.snapshot(), await f.engine.snapshot());
  assert.equal((await restored.status()).pending, false);
  const wrong = await f.open("wrong-key.db");
  const wrongReplica = await makeReplica(
    f,
    drive,
    { ...newPairing, deviceId: randomUUID() },
    newShopEncryptionKey(),
    { ...f, ...wrong },
  );
  await assert.rejects(wrongReplica.sync(), DriveSyncError);
  assert.equal(await wrong.store.load(f.shopId), null);
  const dirty = await f.open("dirty-device.db");
  await dirty.engine.createCategory(randomUUID(), {
    name: "Unsynced local work",
    trackingKind: "QUANTITY",
  });
  const before = await dirty.engine.snapshot();
  const conflict = await makeReplica(
    f,
    drive,
    { ...newPairing, deviceId: randomUUID() },
    key,
    { ...f, ...dirty },
  );
  await assert.rejects(
    conflict.sync(),
    (error: unknown) =>
      error instanceof DriveSyncError && error.code === "REVISION_CONFLICT",
  );
  assert.deepEqual(await dirty.engine.snapshot(), before);
});

test("native-safe UTF-8 and base64 codecs preserve Bangla, emoji and binary snapshot bytes", () => {
  const value = "হাওলাদার ব্যাটারি 🔋 ৳১২৩";
  assert.deepEqual(utf8(value), new TextEncoder().encode(value));
  assert.equal(fromUtf8(utf8(value)), value);
  for (let size = 0; size < 70; size++) {
    const bytes = new Uint8Array(
      Array.from({ length: size }, (_, index) => (index * 37) % 256),
    );
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  }
});

async function batteryFixture(months = 6) {
  const f = await fixture();
  const category = await f.engine.createCategory(randomUUID(), {
    name: "Battery",
    trackingKind: "BATTERY_UNIT",
  });
  const supplier = await f.engine.createContact(randomUUID(), {
    kind: "supplier",
    name: "Battery supplier",
    phone: "01700000004",
    categoryId: category.id,
  });
  const product = await f.engine.createProduct(randomUUID(), {
    categoryId: category.id,
    name: "Auto Life",
    warrantyMonths: months,
  });
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: supplier.id,
    date: "2026-01-30",
    reference: "BATT-RECEIPT",
    items: [
      {
        productId: product.id,
        quantity: 3,
        unitPrice: "8000",
        batteryIdentities: [
          { serialNumber: "BAT-A" },
          { serialNumber: "BAT-B" },
          { serialNumber: "BAT-C" },
        ],
      },
    ],
    paid: "0",
  });
  const units = Object.values((await f.engine.snapshot()).batteryUnits);
  return { ...f, batterySupplier: supplier, battery: product, units };
}

test("battery sale preserves unit identity, exact cost and calendar-month warranty", async () => {
  const f = await batteryFixture(1);
  const sale = await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-01-31",
    items: [
      {
        productId: f.battery.id,
        quantity: 1,
        unitPrice: "10000",
        unitIds: [f.units[0].id],
      },
    ],
    paid: "5000",
  });
  const state = await f.engine.snapshot();
  const unit = state.batteryUnits[f.units[0].id];
  assert.equal(sale.cost, "8000.00");
  assert.equal(unit.customerId, f.customer.id);
  assert.equal(unit.state, "SOLD");
  assert.equal(unit.coverageEnd, "2026-02-28");
  assert.equal(
    state.batches.find((batch) => batch.productId === f.battery.id)!.available,
    2,
  );
  assert.equal(warrantyExpiry("2028-01-31", 1), "2028-02-29");
  const before = await f.engine.snapshot();
  await rejects(
    f.engine.completeSale(randomUUID(), {
      customerId: f.customer.id,
      date: "2026-02-01",
      items: [
        {
          productId: f.battery.id,
          quantity: 1,
          unitPrice: "10000",
          unitIds: [unit.id],
        },
      ],
      paid: "0",
    }),
    "INSUFFICIENT_STOCK",
  );
  assert.deepEqual(await f.engine.snapshot(), before);
});

test("customer warranty replacement cannot become shop stock or change invoice balances", async () => {
  const f = await batteryFixture();
  const sale = await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-01-31",
    items: [
      {
        productId: f.battery.id,
        quantity: 1,
        unitPrice: "10000",
        unitIds: [f.units[0].id],
      },
    ],
    paid: "5000",
  });
  const before = await f.engine.snapshot();
  const intake = await f.engine.intakeReplacement(randomUUID(), {
    unitId: f.units[0].id,
    supplierId: f.batterySupplier.id,
    source: "CUSTOMER_WARRANTY",
    date: "2026-02-05",
    reason: "No charge",
  });
  const sent = await f.engine.dispatchReplacement(randomUUID(), {
    id: intake.id,
    version: intake.version,
    date: "2026-02-06",
  });
  const received = await f.engine.receiveReplacement(randomUUID(), {
    id: intake.id,
    version: sent.version,
    date: "2026-02-07",
    serialNumber: "BAT-A-NEW",
  });
  let state = await f.engine.snapshot();
  const replacement = state.batteryUnits[received.replacementUnitId!];
  assert.equal(replacement.owner, "CUSTOMER");
  assert.equal(replacement.state, "READY");
  assert.equal(replacement.coverageEnd, "2026-07-31");
  assert.equal(state.batteryUnits[f.units[0].id].state, "RETIRED");
  assert.equal(
    state.batches.find((batch) => batch.productId === f.battery.id)!.available,
    2,
  );
  await f.engine.deliverReplacement(randomUUID(), {
    id: intake.id,
    version: received.version,
    date: "2026-02-08",
  });
  state = await f.engine.snapshot();
  assert.equal(state.batteryUnits[replacement.id].custody, "CUSTOMER");
  assert.deepEqual(state.journals, before.journals);
  assert.deepEqual(state.sales[sale.id], before.sales[sale.id]);
  validateLocalState(state, f.shopId);
});

test("before-sale replacement restores stock at original cost and cancellation reverses only an undispatched intake", async () => {
  const f = await batteryFixture();
  const before = await f.engine.snapshot();
  const initial = await f.engine.intakeReplacement(randomUUID(), {
    unitId: f.units[0].id,
    supplierId: f.batterySupplier.id,
    source: "BEFORE_SALE",
    date: "2026-02-01",
    reason: "Faulty stock",
  });
  assert.equal(
    (await f.engine.snapshot()).batches.find(
      (batch) => batch.productId === f.battery.id,
    )!.available,
    2,
  );
  await f.engine.cancelReplacement(randomUUID(), {
    id: initial.id,
    version: initial.version,
  });
  assert.equal(
    (await f.engine.snapshot()).batches.find(
      (batch) => batch.productId === f.battery.id,
    )!.available,
    3,
  );
  const intake = await f.engine.intakeReplacement(randomUUID(), {
    unitId: f.units[0].id,
    supplierId: f.batterySupplier.id,
    source: "BEFORE_SALE",
    date: "2026-02-02",
    reason: "Supplier replacement",
  });
  const sent = await f.engine.dispatchReplacement(randomUUID(), {
    id: intake.id,
    version: 1,
    date: "2026-02-03",
  });
  await rejects(
    f.engine.cancelReplacement(randomUUID(), {
      id: intake.id,
      version: sent.version,
    }),
    "REPLACEMENT_CHANGED",
  );
  const received = await f.engine.receiveReplacement(randomUUID(), {
    id: intake.id,
    version: sent.version,
    date: "2026-02-04",
    serialNumber: "BAT-A-REPLACED",
  });
  const state = await f.engine.snapshot();
  assert.equal(received.stage, "COMPLETED");
  assert.equal(
    state.batteryUnits[received.replacementUnitId!].state,
    "AVAILABLE",
  );
  assert.equal(
    state.batches.find((batch) => batch.productId === f.battery.id)!.available,
    3,
  );
  assert.deepEqual(state.journals, before.journals);
  validateLocalState(state, f.shopId);
});

test("expired warranty, duplicate serials and stale replacement versions cannot silently post", async () => {
  const f = await batteryFixture(1);
  await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-01-31",
    items: [
      {
        productId: f.battery.id,
        quantity: 1,
        unitPrice: "10000",
        unitIds: [f.units[0].id],
      },
    ],
    paid: "0",
  });
  const intake = await f.engine.intakeReplacement(randomUUID(), {
    unitId: f.units[0].id,
    supplierId: f.batterySupplier.id,
    source: "CUSTOMER_WARRANTY",
    date: "2026-03-01",
    reason: "Expired claim",
  });
  assert.equal(intake.eligible, false);
  const sent = await f.engine.dispatchReplacement(randomUUID(), {
    id: intake.id,
    version: 1,
    date: "2026-03-02",
  });
  const before = await f.engine.snapshot();
  await rejects(
    f.engine.receiveReplacement(randomUUID(), {
      id: intake.id,
      version: sent.version,
      date: "2026-03-03",
      serialNumber: "BATT-X",
    }),
    "WARRANTY_EXPIRED",
  );
  await rejects(
    f.engine.dispatchReplacement(randomUUID(), {
      id: intake.id,
      version: 1,
      date: "2026-03-03",
    }),
    "REPLACEMENT_CHANGED",
  );
  await rejects(
    f.engine.receivePurchase(randomUUID(), {
      supplierId: f.batterySupplier.id,
      date: "2026-03-03",
      reference: "DUP",
      items: [
        {
          productId: f.battery.id,
          quantity: 1,
          unitPrice: "8000",
          batteryIdentities: [{ serialNumber: "bat-a" }],
        },
      ],
      paid: "0",
    }),
    "DUPLICATE_SERIAL",
  );
  assert.deepEqual(await f.engine.snapshot(), before);
  await f.engine.rejectReplacement(randomUUID(), {
    id: intake.id,
    version: sent.version,
    date: "2026-03-03",
    reason: "Outside warranty",
  });
  assert.equal(
    (await f.engine.snapshot()).batteryUnits[f.units[0].id].custody,
    "CUSTOMER",
  );
});

test("local SQLite posts purchase, sale, customer collection and supplier payment with balanced accounting", async () => {
  const f = await fixture();
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: f.supplier.id,
    date: "2026-11-18",
    reference: "CH-1",
    items: [{ productId: f.product.id, quantity: 50, unitPrice: "80" }],
    paid: "1000",
    transport: "50",
  });
  const sale = await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-11-19",
    items: [{ productId: f.product.id, quantity: 5, unitPrice: "140" }],
    paid: "500",
  });
  assert.equal(sale.total, "700.00");
  assert.equal(sale.cost, "400.00");
  await f.engine.recordPayment(randomUUID(), {
    contactId: f.customer.id,
    date: "2026-11-20",
    amount: "150",
  });
  await f.engine.recordPayment(randomUUID(), {
    contactId: f.supplier.id,
    date: "2026-11-20",
    amount: "500",
  });
  const state = await f.engine.snapshot();
  assert.equal(state.batches[0].available, 45);
  assert.equal(state.sales[sale.id].paid, "650.00");
  assert.equal(Object.values(state.purchases)[0].paid, "1500.00");
  validateLocalState(state, f.shopId);
  const ledger = await f.engine.customerLedger(f.customer.id);
  assert.equal(ledger[0].description, "Due collection");
  assert.equal(ledger[0].sale, null);
  assert.equal(ledger[0].balance, "50.00");
  assert.equal(ledger[1].paid, "500.00");
  assert.equal(ledger[1].balance, "200.00");
});

test("local SQLite survives restart and replays a saved sale without duplicating stock or invoice", async () => {
  const f = await fixture();
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: f.supplier.id,
    date: "2026-11-18",
    reference: "CH-2",
    items: [{ productId: f.product.id, quantity: 10, unitPrice: "10" }],
    paid: "0",
  });
  const key = randomUUID();
  const input = {
    customerId: f.customer.id,
    date: "2026-11-19",
    items: [{ productId: f.product.id, quantity: 2, unitPrice: "20" }],
    paid: "0",
  };
  const first = await f.engine.completeSale(key, input);
  f.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.engine.completeSale(key, input), first);
  const state = await reopened.engine.snapshot();
  assert.equal(Object.keys(state.sales).length, 1);
  assert.equal(state.batches[0].available, 8);
  assert.equal(state.nextSale, 2);
  await rejects(
    reopened.engine.completeSale(key, { ...input, paid: "1" }),
    "KEY_REUSED",
  );
});

test("an insufficient-stock failure rolls back all sale lines, journal, request cache and counter", async () => {
  const f = await fixture();
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: f.supplier.id,
    date: "2026-11-18",
    reference: "CH-3",
    items: [{ productId: f.product.id, quantity: 3, unitPrice: "10" }],
    paid: "0",
  });
  const before = await f.engine.snapshot();
  await rejects(
    f.engine.completeSale(randomUUID(), {
      customerId: f.customer.id,
      date: "2026-11-19",
      items: [
        { productId: f.product.id, quantity: 2, unitPrice: "20" },
        { productId: f.product.id, quantity: 2, unitPrice: "20" },
      ],
      paid: "0",
    }),
    "INSUFFICIENT_STOCK",
  );
  assert.deepEqual(await f.engine.snapshot(), before);
});

test("local FIFO uses receipt dates and preserves exact decimal costs across multiple batches", async () => {
  const f = await fixture();
  for (const entry of [
    { date: "2026-11-20", unitPrice: "0.20" },
    { date: "2026-11-18", unitPrice: "0.10" },
  ])
    await f.engine.receivePurchase(randomUUID(), {
      supplierId: f.supplier.id,
      date: entry.date,
      reference: entry.date,
      items: [
        { productId: f.product.id, quantity: 2, unitPrice: entry.unitPrice },
      ],
      paid: "0",
    });
  const sale = await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-11-21",
    items: [{ productId: f.product.id, quantity: 3, unitPrice: "0.30" }],
    paid: "0.30",
  });
  assert.equal(sale.total, "0.90");
  assert.equal(sale.cost, "0.40");
  const state = await f.engine.snapshot();
  assert.equal(
    state.batches.find((batch) => batch.date === "2026-11-18")!.available,
    0,
  );
  assert.equal(
    state.batches.find((batch) => batch.date === "2026-11-20")!.available,
    1,
  );
});

test("invalid amounts, quantities, dates and overpayments never change local data", async () => {
  const f = await fixture();
  const before = await f.engine.snapshot();
  const body = {
    supplierId: f.supplier.id,
    date: "2026-11-18",
    reference: "CH-X",
    items: [{ productId: f.product.id, quantity: 1, unitPrice: "1" }],
    paid: "0",
  };
  await rejects(
    f.engine.receivePurchase(randomUUID(), { ...body, paid: "2" }),
    "OVERPAYMENT",
  );
  await rejects(
    f.engine.receivePurchase(randomUUID(), { ...body, date: "2026-02-30" }),
    "INVALID_DATE",
  );
  await rejects(
    f.engine.receivePurchase(randomUUID(), {
      ...body,
      items: [{ ...body.items[0], quantity: 1.5 }],
    }),
    "INVALID_QUANTITY",
  );
  await rejects(
    f.engine.receivePurchase(randomUUID(), {
      ...body,
      items: [{ ...body.items[0], unitPrice: "1e3" }],
    }),
    "INVALID_AMOUNT",
  );
  assert.deepEqual(await f.engine.snapshot(), before);
  assert.equal(money(amount("999999999999999999.99")), "999999999999999999.99");
  assert.throws(() => amount("NaN"), LocalErpError);
});

test("shop scopes stay isolated and a compare-and-swap collision cannot overwrite another local writer", async () => {
  const f = await fixture();
  const other = new LocalErp(f.store, randomUUID(), f.actor);
  assert.equal(Object.keys((await other.snapshot()).products).length, 0);
  const current = (await f.store.load(f.shopId))!;
  const winning = structuredClone(current.state);
  const categoryId = randomUUID();
  winning.categories[categoryId] = {
    id: categoryId,
    name: "Other write",
    trackingKind: "QUANTITY",
  };
  assert.equal(await f.store.commit(f.shopId, current.revision, winning), true);
  assert.equal(
    await f.store.commit(f.shopId, current.revision, current.state),
    false,
  );
  assert.equal(
    Object.values((await f.engine.snapshot()).categories).some(
      (category) => category.name === "Other write",
    ),
    true,
  );
});

test("a new device can restore the approved shop snapshot without overwriting an occupied device", async () => {
  const f = await fixture();
  await f.engine.receivePurchase(randomUUID(), {
    supplierId: f.supplier.id,
    date: "2026-11-18",
    reference: "RECOVERY",
    items: [{ productId: f.product.id, quantity: 10, unitPrice: "80" }],
    paid: "0",
  });
  await f.engine.completeSale(randomUUID(), {
    customerId: f.customer.id,
    date: "2026-11-19",
    items: [{ productId: f.product.id, quantity: 2, unitPrice: "140" }],
    paid: "100",
  });
  const snapshot = await f.engine.snapshot();
  const device = await f.open("second-device.db");
  await restoreNewLocalShop(device.store, f.shopId, snapshot);
  assert.deepEqual(await device.engine.snapshot(), snapshot);
  assert.deepEqual(
    await device.engine.customerLedger(f.customer.id),
    await f.engine.customerLedger(f.customer.id),
  );
  await rejects(
    restoreNewLocalShop(device.store, f.shopId, snapshot),
    "LOCAL_NOT_EMPTY",
  );
  assert.deepEqual(await device.engine.snapshot(), snapshot);
});

test("new-device recovery rejects a wrong shop or inconsistent accounting before saving", async () => {
  const f = await fixture();
  const snapshot = await f.engine.snapshot();
  const device = await f.open("recovery-check.db");
  const otherShopId = randomUUID();
  await rejects(
    restoreNewLocalShop(device.store, otherShopId, snapshot),
    "WRONG_SHOP",
  );
  assert.equal(await device.store.load(otherShopId), null);
  const corrupt = structuredClone(snapshot);
  corrupt.journals.push({
    id: randomUUID(),
    date: "2026-11-20",
    kind: "corrupt",
    lines: [
      { account: "1300", debit: "100", credit: "0" },
      { account: "2100", debit: "0", credit: "100" },
    ],
  });
  await rejects(
    restoreNewLocalShop(device.store, f.shopId, corrupt),
    "INVALID_STATE",
  );
  assert.equal(await device.store.load(f.shopId), null);
  await device.engine.snapshot();
  await restoreNewLocalShop(device.store, f.shopId, snapshot);
  assert.deepEqual(await device.engine.snapshot(), snapshot);
});

test("failed local persistence is never acknowledged as a successful purchase", async () => {
  const f = await fixture();
  const before = await f.engine.snapshot();
  const failing: LocalErpStore = {
    load: f.store.load,
    async commit() {
      throw Error("Simulated disk full");
    },
  };
  const engine = new LocalErp(failing, f.shopId, f.actor);
  await assert.rejects(
    engine.receivePurchase(randomUUID(), {
      supplierId: f.supplier.id,
      date: "2026-11-18",
      reference: "CH-4",
      items: [{ productId: f.product.id, quantity: 10, unitPrice: "10" }],
      paid: "0",
    }),
    /disk full/,
  );
  assert.deepEqual(await f.engine.snapshot(), before);
});

test("invalid battery identities and unauthorized finance actions fail without changing data", async () => {
  const f = await fixture();
  const batteryCategory = await f.engine.createCategory(randomUUID(), {
    name: "Battery",
    trackingKind: "BATTERY_UNIT",
  });
  const supplier = await f.engine.createContact(randomUUID(), {
    kind: "supplier",
    name: "Battery supplier",
    phone: "01700000003",
    categoryId: batteryCategory.id,
  });
  const battery = await f.engine.createProduct(randomUUID(), {
    categoryId: batteryCategory.id,
    name: "Auto Life",
  });
  const before = await f.engine.snapshot();
  await rejects(
    f.engine.receivePurchase(randomUUID(), {
      supplierId: supplier.id,
      date: "2026-11-18",
      reference: "BAT-1",
      items: [
        {
          productId: battery.id,
          quantity: 1,
          unitPrice: "8000",
          batteryIdentities: [{ serialNumber: "A" }, { serialNumber: "B" }],
        },
      ],
      paid: "0",
    }),
    "INVALID_IDENTITIES",
  );
  const noFinance = new LocalErp(f.store, f.shopId, {
    id: "limited",
    permissions: ["purchases.manage"],
  });
  await rejects(
    noFinance.receivePurchase(randomUUID(), {
      supplierId: f.supplier.id,
      date: "2026-11-18",
      reference: "CH-5",
      items: [{ productId: f.product.id, quantity: 1, unitPrice: "80" }],
      paid: "10",
    }),
    "ACCESS_DENIED",
  );
  assert.deepEqual(await f.engine.snapshot(), before);
});
