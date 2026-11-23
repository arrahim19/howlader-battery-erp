import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApp } from "../../apps/api/src/app";
import { DatabaseService } from "../../apps/api/src/database.service";
import { digest, hashPassword } from "../../apps/api/src/auth";
import { settings } from "../../apps/api/src/config";

assert.equal(process.env.ERP_INTEGRATION_TEST, "true");
assert(new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"));
let app: INestApplication;
let db: DatabaseService;
const password = "648193";
async function identity() {
  const login = "native-" + randomUUID();
  const role = await db.global.role.upsert({
    where: { code: "MOBILE_AUTH_TEST" },
    update: {},
    create: { code: "MOBILE_AUTH_TEST", name: "Native test", builtIn: false },
  });
  for (const code of ["dashboard.read", "parties.customers"]) {
    const permission = await db.global.permission.upsert({
      where: { code },
      update: {},
      create: { code, name: code },
    });
    await db.global.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
  const user = await db.global.user.create({
    data: {
      login,
      name: "Native owner",
      passwordHash: await hashPassword(password),
      roles: { create: { roleId: role.id } },
    },
  });
  return user;
}
const nativeLogin = (login: string, secret = password) =>
  request(app.getHttpServer())
    .post("/api/v1/auth/mobile/login")
    .send({ login, password: secret });
before(async () => {
  app = await createApp();
  await app.init();
  db = app.get(DatabaseService);
});
after(async () => {
  await app?.close();
});

test("native login returns an expiring bearer token with no browser cookie or password exposure", async () => {
  const user = await identity();
  const response = await nativeLogin(user.login).expect(201);
  const { accessToken, expiresAt } = response.body.data;
  assert.match(accessToken, /^[a-f0-9]{64}$/);
  assert(new Date(expiresAt) > new Date());
  assert.equal(response.headers["set-cookie"], undefined);
  assert(!JSON.stringify(response.body).includes("passwordHash"));
  const session = await db.global.session.findUniqueOrThrow({
    where: { tokenHash: digest(accessToken) },
  });
  assert.equal(session.userId, user.id);
  assert.notEqual(session.tokenHash, accessToken);
  const current = await request(app.getHttpServer())
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer " + accessToken)
    .expect(200);
  assert.equal(current.body.data.id, user.id);
  assert.equal(current.body.data.shop.branchName, "Betagi");
  await nativeLogin(user.login, "wrong").expect(401);
  await request(app.getHttpServer())
    .post("/api/v1/auth/mobile/login")
    .set("Origin", "https://untrusted.example")
    .send({ login: user.login, password })
    .expect(403);
});

test("native writes require a valid bearer token while cookie clients still require Origin and CSRF", async () => {
  const user = await identity();
  const token = (await nativeLogin(user.login).expect(201)).body.data
    .accessToken;
  const body = {
    name: "Native customer",
    phone: "01700000001",
    address: "Betagi",
  };
  await request(app.getHttpServer())
    .post("/api/v1/customers")
    .set("Authorization", "Bearer " + token)
    .send(body)
    .expect(201);
  await request(app.getHttpServer())
    .post("/api/v1/customers")
    .send(body)
    .expect(403);
  await request(app.getHttpServer())
    .post("/api/v1/customers")
    .set("Authorization", "Bearer " + "00".repeat(32))
    .send(body)
    .expect(401);
  await request(app.getHttpServer())
    .post("/api/v1/customers")
    .set("Authorization", "Bearer " + token)
    .set("Origin", "https://untrusted.example")
    .send(body)
    .expect(403);
  const browser = request.agent(app.getHttpServer());
  const csrf = (await browser.get("/api/v1/auth/csrf").expect(200)).body.data
    .token;
  await browser
    .post("/api/v1/auth/login")
    .set("Origin", settings().origin)
    .set("X-CSRF-Token", csrf)
    .send({ login: user.login, password })
    .expect(201);
  await browser
    .post("/api/v1/customers")
    .set("Origin", settings().origin)
    .send(body)
    .expect(403);
  await browser
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer invalid")
    .expect(401);
  await browser.get("/api/v1/auth/me").expect(200);
  await request(app.getHttpServer())
    .post("/api/v1/auth/logout")
    .set("Authorization", "Bearer " + token)
    .send({})
    .expect(201);
  await request(app.getHttpServer())
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer " + token)
    .expect(401);
  await browser.get("/api/v1/auth/me").expect(200);
});

test("native password changes revoke mobile sessions on all devices and allow a six digit new password", async () => {
  const user = await identity();
  const one = (await nativeLogin(user.login).expect(201)).body.data.accessToken;
  const two = (await nativeLogin(user.login).expect(201)).body.data.accessToken;
  await request(app.getHttpServer())
    .post("/api/v1/auth/change-password")
    .set("Authorization", "Bearer " + one)
    .send({ currentPassword: password, newPassword: "916245" })
    .expect(201);
  for (const token of [one, two])
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer " + token)
      .expect(401);
  await nativeLogin(user.login, "916245").expect(201);
});

test("a native device can sync after a long idle period while its revocable credential remains valid", async () => {
  const user = await identity(),
    token = (await nativeLogin(user.login).expect(201)).body.data.accessToken;
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000),
    twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  await db.global.user.update({
    where: { id: user.id },
    data: { passwordChangedAt: threeDaysAgo },
  });
  await db.global.session.update({
    where: { tokenHash: digest(token) },
    data: { createdAt: twoDaysAgo, lastSeenAt: twoDaysAgo },
  });
  const before = await db.global.session.findUniqueOrThrow({
    where: { tokenHash: digest(token) },
  });
  assert(before.deviceSession);
  await request(app.getHttpServer())
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer " + token)
    .expect(200);
  await db.global.session.update({
    where: { tokenHash: digest(token) },
    data: { revokedAt: new Date() },
  });
  await request(app.getHttpServer())
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer " + token)
    .expect(401);
});

test("native device bootstrap is shop-scoped and offline-created entities replay once with their UUIDs", async () => {
  const user = await identity();
  const role = await db.global.role.findUniqueOrThrow({
    where: { code: "MOBILE_AUTH_TEST" },
  });
  for (const code of [
    "inventory.read",
    "sales.manage",
    "purchases.manage",
    "finance.read",
    "finance.write",
    "parties.suppliers",
    "catalog.write",
    "access.manage",
  ]) {
    const permission = await db.global.permission.upsert({
      where: { code },
      update: {},
      create: { code, name: code },
    });
    await db.global.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
  const token = (await nativeLogin(user.login).expect(201)).body.data
    .accessToken;
  const key = randomUUID(),
    body = {
      name: "Offline customer",
      phone: "01700000222",
      address: "Betagi",
    };
  const create = () =>
    request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("Authorization", "Bearer " + token)
      .set("Idempotency-Key", key)
      .send(body);
  const [one, two] = await Promise.all([
    create().expect(201),
    create().expect(201),
  ]);
  assert.equal(one.body.data.id, key);
  assert.deepEqual(one.body, two.body);
  assert.equal(await db.global.customer.count({ where: { id: key } }), 1);
  await request(app.getHttpServer())
    .post("/api/v1/customers")
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", key)
    .send({ ...body, name: "Different" })
    .expect(409);
  const type = await db.global.productType.findFirstOrThrow({
    where: { trackingKind: "QUANTITY", active: true },
  });
  const productId = randomUUID(),
    product = {
      typeId: type.id,
      name: "Offline item " + productId,
      category: "Offline category " + productId,
      unit: "pcs",
      defaultSellingPrice: "100.00",
      lowStockThreshold: "0",
      warrantyMonths: 0,
    };
  const createProduct = () =>
    request(app.getHttpServer())
      .post("/api/v1/products")
      .set("Authorization", "Bearer " + token)
      .set("Idempotency-Key", productId)
      .send(product);
  const first = await createProduct().expect(201),
    second = await createProduct().expect(201);
  assert.equal(first.body.data.id, productId);
  assert.deepEqual(first.body, second.body);
  const bootstrap = await request(app.getHttpServer())
    .get("/api/v1/mobile/offline-bootstrap")
    .set("Authorization", "Bearer " + token)
    .expect(200);
  assert.equal(bootstrap.body.data.version, 1);
  assert(
    bootstrap.body.data.views["/customers"].items.some(
      (c: { id: string }) => c.id === key,
    ),
  );
  assert(
    bootstrap.body.data.views["/products"].items.some(
      (p: { id: string }) => p.id === productId,
    ),
  );
  assert(!JSON.stringify(bootstrap.body).includes("passwordHash"));
  assert(!JSON.stringify(bootstrap.body).includes("tokenHash"));
  assert(bootstrap.body.data.views["/mobile/facts"]);
  assert(bootstrap.body.data.views["/dashboard"]);
  const readerRole = await db.global.role.create({
    data: {
      code: "OFFLINE_READER_" + randomUUID(),
      name: "Offline stock reader",
      builtIn: false,
    },
  });
  const inventoryPermission = await db.global.permission.findUniqueOrThrow({
    where: { code: "inventory.read" },
  });
  await db.global.rolePermission.create({
    data: { roleId: readerRole.id, permissionId: inventoryPermission.id },
  });
  const reader = await db.global.user.create({
    data: {
      name: "Offline reader",
      login: "reader-" + randomUUID(),
      passwordHash: await hashPassword(password),
      roles: { create: { roleId: readerRole.id } },
    },
  });
  const readerToken = (await nativeLogin(reader.login).expect(201)).body.data
    .accessToken;
  const readerBootstrap = await request(app.getHttpServer())
    .get("/api/v1/mobile/offline-bootstrap")
    .set("Authorization", "Bearer " + readerToken)
    .expect(200);
  assert(readerBootstrap.body.data.views["/products"].items.length > 0);
  assert(
    readerBootstrap.body.data.views["/products"].items.every(
      (p: { latestPurchasePrice: unknown }) => p.latestPurchasePrice === null,
    ),
  );
  assert(
    readerBootstrap.body.data.views["/mobile/facts"].batches.every(
      (b: { unitCost: unknown }) => b.unitCost === null,
    ),
  );
  assert(!readerBootstrap.body.data.views["/customers"]);
  await request(app.getHttpServer())
    .get("/api/v1/mobile/offline-bootstrap")
    .expect(401);
});
