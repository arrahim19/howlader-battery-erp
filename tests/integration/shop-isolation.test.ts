import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../apps/api/src/app";
import { DatabaseService } from "../../apps/api/src/database.service";
import { AccountMailService } from "../../apps/api/src/account-mail";
import {
  provisionShop,
  migrateShopDatabases,
} from "../../apps/api/src/shop-provisioning";
import { settings } from "../../apps/api/src/config";

assert.equal(process.env.ERP_INTEGRATION_TEST, "true");
assert(new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"));
type Agent = ReturnType<typeof request.agent>;
let app: INestApplication;
let db: DatabaseService;
let first: Awaited<ReturnType<typeof provisionShop>>;
let second: Awaited<ReturnType<typeof provisionShop>>;
let a: Agent;
let b: Agent;
const password = "739152";
const mails: { to: string; text: string }[] = [];
const connectionString = () =>
  process.env.DATABASE_URL_UNPOOLED || settings().databaseUrl;
async function csrf(agent: Agent) {
  return (await agent.get("/api/v1/auth/csrf").expect(200)).body.data.token;
}
async function post(
  agent: Agent,
  path: string,
  body: object,
  key = randomUUID(),
) {
  const token = await csrf(agent);
  return agent
    .post("/api/v1" + path)
    .set("Origin", settings().origin)
    .set("X-CSRF-Token", token)
    .set("Idempotency-Key", key)
    .send(body);
}
function lastToken() {
  const token = mails.at(-1)?.text.match(/#token=([a-f0-9]{64})/)?.[1];
  assert(token);
  return token;
}
async function activate(email: string) {
  const agent = request.agent(app.getHttpServer());
  assert.equal(
    (await post(agent, "/auth/forgot-password", { email })).status,
    201,
  );
  assert.equal(mails.at(-1)?.to, email);
  const token = lastToken();
  assert.equal(
    (
      await post(agent, "/auth/reset-password", {
        token,
        newPassword: password,
      })
    ).status,
    400,
  );
  const response = await post(agent, "/auth/activate-account", {
    token,
    newPassword: password,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(
    (
      await post(agent, "/auth/activate-account", {
        token,
        newPassword: password,
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(agent, "/auth/login", { login: email, password })).status,
    201,
  );
  return agent;
}

before(async () => {
  app = await createApp();
  await app.init();
  db = app.get(DatabaseService);
  const mail = app.get(AccountMailService);
  mail.configured = () => true;
  mail.send = async (to, _subject, text) => {
    mails.push({ to, text });
  };
  const before = await Promise.all([
    db.global.sale.count(),
    db.global.purchase.count(),
    db.global.journalLine.count(),
    db.global.stockMovement.count(),
    db.global.user.count(),
  ]);
  first = await provisionShop({
    connectionString: connectionString(),
    name: "Same Shop Name",
    branchName: "Betagi test " + randomUUID(),
    email: `first-${randomUUID()}@example.com`,
  });
  second = await provisionShop({
    connectionString: connectionString(),
    name: "Same Shop Name",
    branchName: "Mirzaganj test " + randomUUID(),
    email: `second-${randomUUID()}@example.com`,
  });
  assert.deepEqual(
    await Promise.all([
      db.global.sale.count(),
      db.global.purchase.count(),
      db.global.journalLine.count(),
      db.global.stockMovement.count(),
      db.global.user.count(),
    ]),
    before,
    "Provisioning must preserve every original shop record.",
  );
  a = await activate(first.email);
  b = await activate(second.email);
});
after(async () => {
  await app?.close();
});

test("separate shop provisioning activates email accounts and starts with empty ledgers and stock", async () => {
  for (const [agent, shop] of [
    [a, first],
    [b, second],
  ] as const) {
    const current = (await agent.get("/api/v1/auth/me").expect(200)).body.data;
    assert.equal(current.id, shop.userId);
    assert.equal(current.shop.id, shop.shopId);
    assert.equal(current.shop.branchName, shop.branchName);
    const native = await request(app.getHttpServer())
      .post("/api/v1/auth/mobile/login")
      .send({ login: shop.email, password })
      .expect(201);
    const nativeUsers = await request(app.getHttpServer())
      .get("/api/v1/users")
      .set("Authorization", "Bearer " + native.body.data.accessToken)
      .expect(200);
    assert.deepEqual(
      nativeUsers.body.data.map((row: { id: string }) => row.id),
      [shop.userId],
    );
    const client = db.forSchema(shop.schemaName);
    assert.equal(await client.sale.count(), 0);
    assert.equal(await client.stockBatch.count(), 0);
    assert.equal(await client.journalLine.count(), 0);
    assert.equal(await client.account.count(), 12);
    assert.equal(await client.productType.count(), 3);
    const users = (await agent.get("/api/v1/users").expect(200)).body.data;
    assert.deepEqual(
      users.map((row: { id: string }) => row.id),
      [shop.userId],
    );
    assert.equal(
      (await agent.get("/api/v1/settings/shop").expect(200)).body.data.value
        .name,
      "Same Shop Name",
    );
  }
  const count = await db.global.shop.count();
  await assert.rejects(
    provisionShop({
      connectionString: connectionString(),
      name: "Duplicate",
      branchName: "duplicate " + randomUUID(),
      email: first.email,
    }),
    /already registered/,
  );
  assert.equal(await db.global.shop.count(), count);
  assert.equal(await migrateShopDatabases(connectionString()), 2);
});

test("concurrent shop requests never share customers, users, settings, or raw SQL reports", async () => {
  const [ca, cb] = await Promise.all([
    post(a, "/customers", {
      name: "First shop customer",
      phone: "01700000001",
      address: "Betagi",
    }),
    post(b, "/customers", {
      name: "Second shop customer",
      phone: "01700000002",
      address: "Mirzaganj",
    }),
  ]);
  assert.equal(ca.status, 201, JSON.stringify(ca.body));
  assert.equal(cb.status, 201, JSON.stringify(cb.body));
  for (let i = 0; i < 8; i++) {
    const [ra, rb] = await Promise.all([
      a.get("/api/v1/customers"),
      b.get("/api/v1/customers"),
    ]);
    assert.deepEqual(
      ra.body.data.items.map((row: { id: string }) => row.id),
      [ca.body.data.id],
    );
    assert.deepEqual(
      rb.body.data.items.map((row: { id: string }) => row.id),
      [cb.body.data.id],
    );
  }
  await b.get(`/api/v1/customers/${ca.body.data.id}/ledger`).expect(404);
  assert.equal(
    (
      await post(b, `/users/${first.userId}/profile`, {
        name: "Blocked",
        version: 1,
      })
    ).status,
    404,
  );
  const shop = (await a.get("/api/v1/settings/shop").expect(200)).body.data;
  assert.equal(
    (
      await post(a, "/settings/shop", {
        name: "Same Shop Name",
        address: "Betagi address only",
        phone: "01700000001",
        version: shop.version,
      })
    ).status,
    201,
  );
  assert.equal(
    (await b.get("/api/v1/settings/shop").expect(200)).body.data.value.address,
    "",
  );
  assert.equal(
    (
      await post(b, "/auth/email/request-verification", {
        email: first.email,
        currentPassword: password,
      })
    ).status,
    409,
  );
});

test("purchases, sales, payments, expenses, balances and guessed IDs stay inside their authenticated shop", async () => {
  const one = db.forSchema(first.schemaName);
  const two = db.forSchema(second.schemaName);
  const type = await one.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const productResponse = await post(a, "/products", {
    typeId: type.id,
    name: "Only Betagi Product",
    unit: "piece",
    category: "Only Betagi Name",
    defaultSellingPrice: "150.00",
  });
  assert.equal(
    productResponse.status,
    201,
    JSON.stringify(productResponse.body),
  );
  const product = productResponse.body.data;
  const supplierResponse = await post(a, "/suppliers", {
    name: "Only Betagi Supplier",
    phone: "01700000003",
    productTypeId: type.id,
  });
  assert.equal(
    supplierResponse.status,
    201,
    JSON.stringify(supplierResponse.body),
  );
  const supplier = supplierResponse.body.data;
  const customer = await one.customer.findFirstOrThrow();
  const receiveBody = {
    supplierId: supplier.id,
    purchaseDate: "2026-11-21",
    reference: "Branch isolation purchase",
    items: [{ productId: product.id, quantity: 5, unitPrice: "100.00" }],
  };
  const purchase = await post(a, "/purchases/receive", receiveBody);
  assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
  const guessedPurchase = await post(b, "/purchases/receive", receiveBody);
  assert(
    [400, 404].includes(guessedPurchase.status),
    JSON.stringify(guessedPurchase.body),
  );
  const cash = await one.account.findUniqueOrThrow({ where: { code: "1100" } });
  const saleBody = {
    customerId: customer.id,
    saleDate: "2026-11-21",
    items: [{ productId: product.id, quantity: 2, unitPrice: "150.00" }],
    paidAmount: "100.00",
    paymentAccountId: cash.id,
  };
  const sale = await post(a, "/sales/complete", saleBody);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(sale.body.data.due, "200.00");
  const guessedSale = await post(b, "/sales/complete", saleBody);
  assert(
    [400, 404].includes(guessedSale.status),
    JSON.stringify(guessedSale.body),
  );
  const expense = await post(a, "/expenses", {
    category: "Office Expense",
    expenseDate: "2026-11-21",
    description: "First shop only",
    amount: "10.00",
    paymentAccountId: cash.id,
  });
  assert.equal(expense.status, 201, JSON.stringify(expense.body));
  assert.equal(await two.sale.count(), 0);
  assert.equal(await two.purchase.count(), 0);
  assert.equal(await two.payment.count(), 0);
  assert.equal(await two.journalLine.count(), 0);
  assert.equal(await two.expense.count(), 0);
  assert.equal(await two.stockMovement.count(), 0);
  assert.equal(await two.supplier.count(), 0);
  assert.equal(await two.product.count(), 0);
  const reportA = (
    await a
      .get("/api/v1/reports/financial-summary?from=2026-11-21&to=2026-11-21")
      .expect(200)
  ).body.data;
  const reportB = (
    await b
      .get("/api/v1/reports/financial-summary?from=2026-11-21&to=2026-11-21")
      .expect(200)
  ).body.data;
  assert.notDeepEqual(reportA, reportB);
  for (const route of [
    "/sales",
    "/purchases",
    "/products",
    "/suppliers",
    "/expenses",
  ]) {
    const result = (await b.get("/api/v1" + route).expect(200)).body.data;
    assert.equal(result.items.length, 0, route);
  }
  const audit = (await b.get("/api/v1/audit-logs").expect(200)).body.data;
  assert(
    !audit.some(
      (row: { resourceId: string }) =>
        row.resourceId === product.id || row.resourceId === sale.body.data.id,
    ),
  );
});

test("email reset and branch deactivation use the correct shop without affecting another shop", async () => {
  const anonymous = request.agent(app.getHttpServer());
  assert.equal(
    (await post(anonymous, "/auth/forgot-password", { email: second.email }))
      .status,
    201,
  );
  const token = lastToken();
  const nextPassword = "changed-" + randomUUID();
  assert.equal(
    (
      await post(anonymous, "/auth/reset-password", {
        token,
        newPassword: nextPassword,
      })
    ).status,
    201,
  );
  await b.get("/api/v1/auth/me").expect(401);
  await a.get("/api/v1/auth/me").expect(200);
  assert.equal(
    (
      await post(anonymous, "/auth/login", {
        login: second.email,
        password: nextPassword,
      })
    ).status,
    201,
  );
  await db.global.shop.update({
    where: { id: second.shopId },
    data: { active: false },
  });
  await anonymous.get("/api/v1/customers").expect(401);
  assert.equal(
    (
      await post(request.agent(app.getHttpServer()), "/auth/login", {
        login: second.email,
        password: nextPassword,
      })
    ).status,
    401,
  );
  await a.get("/api/v1/customers").expect(200);
  await db.global.shop.update({
    where: { id: second.shopId },
    data: { active: true },
  });
});
