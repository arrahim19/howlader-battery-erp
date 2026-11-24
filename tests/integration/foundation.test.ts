import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { hash } from "argon2";
import request from "supertest";
import { createApp } from "../../apps/api/src/app";
import { digest, passwordOptions } from "../../apps/api/src/auth";
import { readSessionIdentity } from "../../apps/api/src/auth-session";
import { DatabaseService } from "../../apps/api/src/database.service";
import { businessRange, DashboardService } from "../../apps/api/src/dashboard";
import { settings } from "../../apps/api/src/config";
import { rolePermissions } from "../../apps/api/src/permissions";
import { Prisma } from "@prisma/client";
import type {
  CurrentUser,
  DashboardData,
  ReplacementList,
} from "../../packages/api-client/src";
type TestAgent = ReturnType<typeof request.agent>;

assert.equal(
  process.env.ERP_INTEGRATION_TEST,
  "true",
  "Run through npm test to isolate fixtures.",
);
assert(new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"));
const id = randomUUID().slice(0, 8);
const password = randomBytes(24).toString("base64url");
let app: INestApplication;
let db: DatabaseService;
let ownerId: string;
let staffId: string;
let owner: TestAgent;
let staff: TestAgent;
const origin = () => settings().origin;

async function csrf(agent: TestAgent) {
  const response = await agent.get("/api/v1/auth/csrf").expect(200);
  return response.body.data.token as string;
}
async function login(agent: TestAgent, login: string) {
  const token = await csrf(agent);
  return agent
    .post("/api/v1/auth/login")
    .set("Origin", origin())
    .set("X-CSRF-Token", token)
    .send({ login, password });
}
before(async () => {
  app = await createApp();
  await app.init();
  db = app.get(DatabaseService);
  for (const code of ["OWNER", "SALES_STAFF"] as const) {
    const role = await db.role.upsert({
      where: { code },
      update: {},
      create: { code, name: code },
    });
    for (const permissionCode of rolePermissions[code]) {
      const permission = await db.permission.upsert({
        where: { code: permissionCode },
        update: {},
        create: { code: permissionCode, name: permissionCode },
      });
      await db.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
  const passwordHash = await hash(password, passwordOptions);
  for (const [login, roleCode] of [
    ["owner-" + id, "OWNER"],
    ["sales-" + id, "SALES_STAFF"],
  ]) {
    const role = await db.role.findUniqueOrThrow({ where: { code: roleCode } });
    const user = await db.user.create({
      data: {
        login,
        name: "Isolated test user",
        passwordHash,
        roles: { create: { roleId: role.id } },
      },
    });
    if (roleCode === "OWNER") ownerId = user.id;
    else staffId = user.id;
  }
  owner = request.agent(app.getHttpServer());
  staff = request.agent(app.getHttpServer());
  assert.equal((await login(owner, "owner-" + id)).status, 201);
  assert.equal((await login(staff, "sales-" + id)).status, 201);
});
after(async () => {
  await app?.close();
});

test("joined session lookup preserves live grants and every session invalidation check", async () => {
  const roles = await db.role.findMany({
    where: { code: { in: ["OWNER", "SALES_STAFF"] } },
  });
  const createdAt = new Date(
    Date.now() - (settings().idleMinutes + 5) * 60_000,
  );
  const changedAt = new Date(createdAt.getTime() - 60_000);
  const user = await db.user.create({
    data: {
      login: "session-query-" + id,
      name: "Session query fixture",
      passwordHash: "unused",
      passwordChangedAt: changedAt,
      roles: { create: roles.map((role) => ({ roleId: role.id })) },
    },
  });
  const token = randomBytes(32).toString("hex");
  const session = await db.session.create({
    data: {
      userId: user.id,
      createdAt,
      tokenHash: digest(token),
      csrfTokenHash: digest("fixture-csrf"),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const me = () =>
    request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `${settings().cookieName}=${token}`);
  const identity = await readSessionIdentity(db, digest(token));
  assert(identity);
  assert.deepEqual(identity.roles, ["OWNER", "SALES_STAFF"]);
  assert.equal(new Set(identity.permissions).size, identity.permissions.length);
  assert(identity.permissions.includes("finance.read"));
  assert.equal("passwordHash" in identity, false);
  assert.equal(await readSessionIdentity(db, "' OR TRUE --"), null);
  await me().expect(200);

  // Permissions are read fresh, even for an already authenticated cookie.
  await db.userRole.deleteMany({ where: { userId: user.id } });
  const noGrants = (await me().expect(200)).body.data;
  assert.deepEqual(noGrants.roles, []);
  assert.deepEqual(noGrants.permissions, []);
  await request(app.getHttpServer())
    .get("/api/v1/dashboard")
    .set("Cookie", `${settings().cookieName}=${token}`)
    .expect(403);

  for (const invalid of [
    { revokedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1000) },
    {
      lastSeenAt: new Date(Date.now() - (settings().idleMinutes + 1) * 60_000),
    },
  ]) {
    await db.session.update({
      where: { id: session.id },
      data: {
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: new Date(),
        ...invalid,
      },
    });
    await me().expect(401);
  }
  await db.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  await db.user.update({ where: { id: user.id }, data: { active: false } });
  await me().expect(401);
  await db.user.update({
    where: { id: user.id },
    data: {
      active: true,
      passwordChangedAt: new Date(session.createdAt.getTime() + 1000),
    },
  });
  await me().expect(401);
  await db.user.update({
    where: { id: user.id },
    data: { passwordChangedAt: changedAt },
  });
  await me().expect(200);
});

test("supplier contacts enforce sessions, permissions, CSRF, and validated fields", async () => {
  const count = await db.supplier.count();
  const type = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const body = {
    name: "Supplier guard " + id,
    phone: "01712345678",
    productTypeId: type.id,
  };
  await request(app.getHttpServer()).get("/api/v1/suppliers").expect(401);
  await request(app.getHttpServer())
    .post("/api/v1/suppliers")
    .set("Origin", origin())
    .send(body)
    .expect(401);
  await staff.get("/api/v1/suppliers").expect(403);
  await staff
    .post("/api/v1/suppliers")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .send(body)
    .expect(403);
  await owner
    .post("/api/v1/suppliers")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  await owner
    .post("/api/v1/suppliers")
    .set("Origin", "https://untrusted.example")
    .set("X-CSRF-Token", await csrf(owner))
    .send(body)
    .expect(403);
  for (const invalid of [
    { ...body, productTypeId: undefined },
    { ...body, productTypeId: randomUUID() },
    { ...body, name: "   " },
    { ...body, phone: "invalid" },
    { ...body, address: 123 },
    { ...body, address: "x".repeat(501) },
    { ...body, active: false },
    { ...body, openingBalance: "1000" },
  ])
    await owner
      .post("/api/v1/suppliers")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(invalid)
      .expect(400);
  await owner.get("/api/v1/suppliers?page=0").expect(400);
  await owner.get("/api/v1/suppliers?pageSize=101").expect(400);
  await owner.get("/api/v1/suppliers?status=unknown").expect(400);
  assert.equal(await db.supplier.count(), count);
});

test("suppliers omit address, are audited, and can be searched and paged", async () => {
  const before = await db.supplier.count();
  const type = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const created = [];
  for (let index = 0; index < 4; index++) {
    const name = `Supplier ${id} ${index}`;
    const response = await owner
      .post("/api/v1/suppliers")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send({
        productTypeId: type.id,
        name: "  " + name + "  ",
        phone: "01712345678",
        company: "  Company " + id + "  ",
      })
      .expect(201);
    const supplier = response.body.data;
    created.push(supplier);
    assert.equal(supplier.name, name);
    assert.equal(supplier.company, "Company " + id);
    assert.equal("address" in supplier, false);
    assert.equal(supplier.active, true);
    assert.equal(supplier.productTypeId, type.id);
    assert.equal(supplier.productType.name, type.name);
    const stored = await db.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    assert.equal("address" in stored, false);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "SUPPLIER_CREATED", resourceId: supplier.id },
    });
    assert.equal(audit.actorId, ownerId);
    assert.equal(audit.requestId, response.headers["x-request-id"]);
  }
  assert.equal(await db.supplier.count(), before + 4);
  const first = (
    await owner.get(`/api/v1/suppliers?q=${id}&pageSize=1`).expect(200)
  ).body.data;
  const second = (
    await owner.get(`/api/v1/suppliers?q=${id}&pageSize=1&page=2`).expect(200)
  ).body.data;
  assert.equal(first.total, 4);
  assert.equal(first.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal("summary" in first, false);
  assert.equal("totalPayable" in first.items[0], false);
  await db.supplier.update({
    where: { id: created[0].id },
    data: { active: false },
  });
  const inactive = (
    await owner.get(`/api/v1/suppliers?q=${id}&status=inactive`).expect(200)
  ).body.data;
  assert.equal(inactive.total, 1);
  assert.equal(inactive.items[0].id, created[0].id);

  const parts = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const types = (await owner.get("/api/v1/suppliers/product-types").expect(200))
    .body.data;
  assert(types.some((item: { id: string }) => item.id === parts.id));
  await staff.get("/api/v1/suppliers/product-types").expect(403);
  const assign = async (supplierId: string, productTypeId: string) =>
    owner
      .post(`/api/v1/suppliers/${supplierId}/category`)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send({ productTypeId });
  assert.equal((await assign(created[1].id, randomUUID())).status, 400);
  assert.equal((await assign(randomUUID(), parts.id)).status, 404);
  const assigned = await assign(created[1].id, parts.id);
  assert.equal(assigned.status, 201);
  assert.equal(assigned.body.data.productTypeId, parts.id);
  assert.equal(assigned.body.data.productType.name, parts.name);
  const filtered = (
    await owner
      .get(`/api/v1/suppliers?q=${id}&productTypeId=${parts.id}`)
      .expect(200)
  ).body.data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, created[1].id);
  await owner.get("/api/v1/suppliers?productTypeId=invalid").expect(400);
  assert.equal(
    (await db.supplier.findUniqueOrThrow({ where: { id: created[1].id } }))
      .productTypeId,
    parts.id,
  );
  assert(
    await db.auditLog.findFirst({
      where: { action: "SUPPLIER_CATEGORY_UPDATED", resourceId: created[1].id },
    }),
  );
});

test("catalog writes require permission, valid fields, Origin, and CSRF", async () => {
  await request(app.getHttpServer()).get("/api/v1/catalog").expect(401);
  await request(app.getHttpServer()).get("/api/v1/products").expect(401);
  await staff.get("/api/v1/catalog").expect(200);
  await staff.get("/api/v1/products").expect(200);
  const body = { name: "Denied type " + id, trackingKind: "QUANTITY" };
  await staff
    .post("/api/v1/product-types")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .send(body)
    .expect(403);
  await staff
    .post("/api/v1/products")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .send({})
    .expect(403);
  await owner
    .post("/api/v1/product-types")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  await owner
    .post("/api/v1/product-types")
    .set("Origin", "https://untrusted.example")
    .set("X-CSRF-Token", await csrf(owner))
    .send(body)
    .expect(403);
  for (const invalid of [
    { ...body, name: "   " },
    { ...body, trackingKind: "CUSTOM" },
    { ...body, active: true },
  ])
    await owner
      .post("/api/v1/product-types")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(invalid)
      .expect(400);
  await owner.get("/api/v1/catalog?typeId=invalid").expect(400);
  await owner.get("/api/v1/products?brandIds=invalid").expect(400);
  await owner.get("/api/v1/products?page=0").expect(400);
  await owner.get("/api/v1/products?pageSize=101").expect(400);
});

test("public API requires the proxy secret while health remains available", async () => {
  const previous = process.env.API_PROXY_SECRET;
  const secret = randomBytes(32).toString("hex");
  let proxyApp: INestApplication | undefined;
  try {
    process.env.API_PROXY_SECRET = secret;
    proxyApp = await createApp();
    await proxyApp.init();
    const server = proxyApp.getHttpServer();
    await request(server).get("/api/v1/health").expect(200);
    await request(server).get("/api/v1/auth/csrf").expect(403);
    await request(server)
      .get("/api/v1/auth/csrf")
      .set("X-ERP-Proxy-Secret", "incorrect")
      .set("X-ERP-Client-IP", "192.0.2.1")
      .expect(403);
    await request(server)
      .get("/api/v1/auth/csrf")
      .set("X-ERP-Proxy-Secret", secret)
      .expect(200);
    await request(server)
      .get("/api/v1/auth/me")
      .set("X-ERP-Proxy-Secret", secret)
      .expect(401);
  } finally {
    if (previous === undefined) delete process.env.API_PROXY_SECRET;
    else process.env.API_PROXY_SECRET = previous;
    await proxyApp?.close();
  }
});

test("fixed product categories and their products persist, filter, and count without creating stock", async () => {
  async function create(path: string, body: object, status = 201) {
    return owner
      .post("/api/v1/" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(body)
      .expect(status);
  }
  const categoryCountsBefore = new Map(
    (
      await db.productType.findMany({
        include: {
          _count: { select: { products: { where: { active: true } } } },
        },
      })
    ).map((type) => [type.id, type._count.products]),
  );
  const stockBefore = await db.stockBatch.count();
  const unitsBefore = await db.batteryUnit.count();
  const productCount = await db.product.count();
  const quantity = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const individual = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const empty = await db.productType.findUniqueOrThrow({
    where: { code: "EASY_BIKE_RICKSHAW" },
  });
  await create(
    "product-types",
    { name: "  CABLES " + id + "  ", trackingKind: "QUANTITY" },
    409,
  );
  const part = {
    typeId: quantity.id,
    name: "Wire " + id,
    model: "1m",
    unit: "piece",
    brand: "Maker " + id,
    category: "Electrical " + id,
    defaultSellingPrice: "125.50",
    lowStockThreshold: "1.5",
    specifications: "Copper",
    warrantyMonths: 6,
  };
  const battery = {
    typeId: individual.id,
    name: "Cell " + id,
    unit: "piece",
    defaultSellingPrice: "15000.00",
    capacityAh: "200",
    model: "Test model",
    warrantyMonths: 18,
  };
  const createdPart = (await create("products", part)).body.data;
  const createdBattery = (await create("products", battery)).body.data;
  assert.equal(createdPart.type.id, quantity.id);
  assert.equal(createdPart.type.trackingKind, "QUANTITY");
  assert.equal(createdPart.category.name, "Electrical " + id);
  assert.equal(createdPart.defaultSellingPrice, "125.50");
  assert.equal(createdBattery.type.id, individual.id);
  assert.equal(createdBattery.brand, null);
  assert.equal(createdBattery.voltage, null);
  assert.equal(Object.hasOwn(createdBattery, "identificationMethod"), false);
  assert.equal(createdBattery.warrantyMonths, 18);
  assert.equal("defaultPurchasePrice" in createdPart, false);
  await create("products", part, 409);
  for (const invalid of [
    { ...part, category: "" },
    { ...part, name: " " },
    { ...part, typeId: randomUUID() },
    { ...part, defaultSellingPrice: "-1" },
    { ...part, defaultSellingPrice: "1.234" },
    { ...part, capacityAh: "12" },
    { ...battery, capacityAh: "0" },
    { ...battery, model: undefined },
    { ...battery, voltage: "0" },
    { ...battery, defaultPurchasePrice: "100" },
  ])
    await create("products", invalid, 400);
  assert.equal(await db.product.count(), productCount + 2);
  assert.equal(await db.stockBatch.count(), stockBefore);
  assert.equal(await db.batteryUnit.count(), unitsBefore);
  assert(
    await db.partsProductDetail.findUnique({
      where: { productId: createdPart.id },
    }),
  );
  assert(
    await db.batteryProductDetail.findUnique({
      where: { productId: createdBattery.id },
    }),
  );
  const metadata = (
    await owner.get(`/api/v1/catalog?typeId=${quantity.id}`).expect(200)
  ).body.data;
  for (const [type, count] of [
    [quantity, 1],
    [individual, 1],
    [empty, 0],
  ] as const)
    assert.equal(
      metadata.types.find((row: { id: string }) => row.id === type.id)
        .productCount,
      (categoryCountsBefore.get(type.id) ?? 0) + count,
    );
  assert.equal(
    metadata.categories.find(
      (row: { id: string }) => row.id === createdPart.category.id,
    ).productCount,
    1,
  );
  const filtered = (
    await owner
      .get(
        `/api/v1/products?typeId=${quantity.id}&brandIds=${createdPart.brand.id}&categoryId=${createdPart.category.id}`,
      )
      .expect(200)
  ).body.data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, createdPart.id);
  const first = (
    await owner.get(`/api/v1/products?q=${id}&pageSize=1`).expect(200)
  ).body.data;
  const second = (
    await owner.get(`/api/v1/products?q=${id}&pageSize=1&page=2`).expect(200)
  ).body.data;
  assert.equal(first.total, 2);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const audits = await db.auditLog.count({
    where: {
      resourceId: {
        in: [
          quantity.id,
          individual.id,
          empty.id,
          createdPart.id,
          createdBattery.id,
        ],
      },
      actorId: ownerId,
    },
  });
  assert.equal(audits, 2);
  const withoutCapacity = (
    await create("products", {
      ...battery,
      name: "Battery without capacity " + id,
      capacityAh: undefined,
    })
  ).body.data;
  assert.equal(withoutCapacity.capacityAh, null);
  assert.equal(withoutCapacity.warrantyMonths, 18);
  await create(
    "products",
    {
      ...battery,
      name: "Battery without capacity " + id,
      capacityAh: undefined,
    },
    409,
  );
  const purchaseOptions = (
    await owner.get("/api/v1/purchases/options").expect(200)
  ).body.data;
  assert.equal(
    purchaseOptions.products.find(
      (item: { id: string }) => item.id === withoutCapacity.id,
    ).capacityAh,
    null,
  );
});

test("product-name groups retain empty links and count and filter separately within each fixed category", async () => {
  async function create(path: string, body: object) {
    return (
      await owner
        .post("/api/v1/" + path)
        .set("Origin", origin())
        .set("X-CSRF-Token", await csrf(owner))
        .send(body)
        .expect(201)
    ).body.data;
  }
  const batteryType = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const partsType = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const emptyType = await db.productType.findUniqueOrThrow({
    where: { code: "EASY_BIKE_RICKSHAW" },
  });
  const groupName = "Shared product name " + id;
  const shared = await create("categories", {
    typeId: batteryType.id,
    name: groupName,
  });
  await create("categories", { typeId: emptyType.id, name: groupName });
  const empty = await create("categories", {
    typeId: partsType.id,
    name: "Unused product name " + id,
  });
  const battery = await create("products", {
    typeId: batteryType.id,
    name: "Grouped battery variant " + id,
    unit: "pcs",
    category: groupName,
    capacityAh: "150",
    voltage: "12",
    model: "Test model",
  });
  const parts: { id: string }[] = [];
  for (const model of ["Small", "Large"])
    parts.push(
      await create("products", {
        typeId: partsType.id,
        name: "Grouped part variant " + id,
        model,
        unit: "pcs",
        category: groupName,
      }),
    );
  assert.equal(battery.brand, null);
  assert.equal(battery.category.id, shared.id);
  const all = (await owner.get("/api/v1/catalog").expect(200)).body.data;
  const group = all.categories.find(
    (row: { id: string }) => row.id === shared.id,
  );
  assert.deepEqual(
    new Set(group.typeIds),
    new Set([batteryType.id, partsType.id, emptyType.id]),
  );
  assert.equal(group.productCount, 3);
  assert.deepEqual(group.productCountsByType, {
    [batteryType.id]: 1,
    [partsType.id]: 2,
    [emptyType.id]: 0,
  });
  const unused = all.categories.find(
    (row: { id: string }) => row.id === empty.id,
  );
  assert.deepEqual(unused.typeIds, [partsType.id]);
  assert.equal(unused.productCount, 0);
  assert.deepEqual(unused.productCountsByType, { [partsType.id]: 0 });
  const scoped = (
    await owner.get(`/api/v1/catalog?typeId=${partsType.id}`).expect(200)
  ).body.data.categories.find((row: { id: string }) => row.id === shared.id);
  assert.equal(scoped.productCount, 2);
  assert.deepEqual(scoped.productCountsByType, group.productCountsByType);
  for (const [type, expected] of [
    [batteryType, [battery.id]],
    [partsType, parts.map((part) => part.id)],
    [emptyType, []],
  ] as const) {
    const filtered = (
      await owner
        .get(`/api/v1/products?typeId=${type.id}&categoryId=${shared.id}`)
        .expect(200)
    ).body.data;
    assert.equal(filtered.total, expected.length);
    assert.deepEqual(
      new Set(filtered.items.map((item: { id: string }) => item.id)),
      new Set(expected),
    );
  }
});

test("product-name deletion requires confirmation and write access, unlinks only its selected type, and preserves used names", async () => {
  const create = async (path: string, body: object) =>
    (
      await owner
        .post("/api/v1/" + path)
        .set("Origin", origin())
        .set("X-CSRF-Token", await csrf(owner))
        .send(body)
        .expect(201)
    ).body.data;
  const firstType = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const otherType = await db.productType.findUniqueOrThrow({
    where: { code: "EASY_BIKE_RICKSHAW" },
  });
  const name = "Shared deletable name " + id;
  const category = await create("categories", { typeId: firstType.id, name });
  assert.equal(
    (await create("categories", { typeId: otherType.id, name })).id,
    category.id,
  );
  const path = "/api/v1/categories/" + category.id;
  const body = { typeId: firstType.id, confirmed: true };
  const remove = async (payload: object, route = path) =>
    owner
      .delete(route)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(payload);
  const auditCount = () =>
    db.auditLog.count({
      where: { action: "PRODUCT_NAME_DELETED", resourceId: category.id },
    });
  const beforeAudit = await auditCount();
  await request(app.getHttpServer())
    .delete(path)
    .set("Origin", origin())
    .send(body)
    .expect(401);
  await staff
    .delete(path)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .send(body)
    .expect(403);
  await owner.delete(path).set("Origin", origin()).send(body).expect(403);
  await owner
    .delete(path)
    .set("Origin", "https://untrusted.example")
    .set("X-CSRF-Token", await csrf(owner))
    .send(body)
    .expect(403);
  for (const invalid of [
    {},
    { typeId: firstType.id },
    { ...body, confirmed: false },
    { ...body, confirmed: "true" },
    { ...body, typeId: "invalid" },
    { ...body, unexpected: true },
  ])
    assert.equal((await remove(invalid)).status, 400);
  assert.equal((await remove(body, "/api/v1/categories/invalid")).status, 400);
  assert.equal((await remove({ ...body, typeId: randomUUID() })).status, 404);
  assert.equal(await auditCount(), beforeAudit);
  assert.equal(
    await db.productTypeCategory.count({ where: { categoryId: category.id } }),
    2,
  );
  const product = await create("products", {
    typeId: otherType.id,
    name: "Protected product variant " + id,
    unit: "pcs",
    category: name,
  });

  const removed = await remove(body);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.data, { deleted: true });
  assert.deepEqual(
    (
      await db.productTypeCategory.findMany({
        where: { categoryId: category.id },
        select: { typeId: true },
      })
    ).map((link) => link.typeId),
    [otherType.id],
  );
  assert(await db.category.findUnique({ where: { id: category.id } }));
  const audit = await db.auditLog.findFirstOrThrow({
    where: { action: "PRODUCT_NAME_DELETED", resourceId: category.id },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(audit.actorId, ownerId);
  assert.equal(audit.requestId, removed.headers["x-request-id"]);
  assert.equal(audit.resourceType, "Category");
  assert.deepEqual(audit.metadata, { typeId: firstType.id, name });
  const metadata = (await owner.get("/api/v1/catalog").expect(200)).body.data;
  assert.deepEqual(
    metadata.categories.find((item: { id: string }) => item.id === category.id)
      .typeIds,
    [otherType.id],
  );
  assert.equal((await remove(body)).status, 404);
  assert.equal(await auditCount(), beforeAudit + 1);

  // All products (including inactive ones) protect their own link.
  for (const active of [true, false]) {
    await db.product.update({ where: { id: product.id }, data: { active } });
    const result = await remove({ typeId: otherType.id, confirmed: true });
    assert.equal(result.status, 409, JSON.stringify(result.body));
  }
  assert(await db.product.findUnique({ where: { id: product.id } }));
  assert(
    await db.productTypeCategory.findUnique({
      where: {
        typeId_categoryId: { typeId: otherType.id, categoryId: category.id },
      },
    }),
  );
  assert.equal(await auditCount(), beforeAudit + 1);

  // Even after the last empty link is removed concurrently, the shared name record/history remains.
  const empty = await create("categories", {
    typeId: firstType.id,
    name: "Last empty product name " + id,
  });
  const race = await Promise.all([
    remove(body, "/api/v1/categories/" + empty.id),
    remove(body, "/api/v1/categories/" + empty.id),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [200, 404]);
  assert.equal(
    await db.productTypeCategory.count({ where: { categoryId: empty.id } }),
    0,
  );
  assert(await db.category.findUnique({ where: { id: empty.id } }));
  assert.equal(
    await db.auditLog.count({
      where: { action: "PRODUCT_NAME_DELETED", resourceId: empty.id },
    }),
    1,
  );
});

test("dashboard trend uses posted revenue less COGS at Dhaka date boundaries", async () => {
  const service = app.get(DashboardService);
  const before = await service.get(true, "2026-01-02", "2026-01-02");
  const accounts = await Promise.all(
    [
      ["4100", "REVENUE"],
      ["5100", "EXPENSE"],
      ["trend-cash-" + id, "ASSET"],
    ].map(([code, kind]) =>
      db.account.upsert({
        where: { code },
        update: {},
        create: {
          code,
          name: "Isolated trend fixture",
          kind: kind as "REVENUE" | "EXPENSE" | "ASSET",
        },
      }),
    ),
  );
  await db.$transaction(async (tx) => {
    const posting = await tx.posting.create({
      data: { actorId: ownerId, kind: "TEST", sourceCode: "trend-" + id },
    });
    const customer = await tx.customer.create({
      data: { name: "Trend customer " + id, phone: "01700000000" },
    });
    await tx.sale.create({
      data: {
        customerId: customer.id,
        status: "CONFIRMED",
        soldAt: new Date("2026-01-01T20:00:00Z"),
        total: 100,
        subtotal: 100,
        postingId: posting.id,
      },
    });
    await tx.journalEntry.create({
      data: {
        postingId: posting.id,
        postedAt: new Date("2026-01-01T20:00:00Z"),
        lines: {
          create: [
            { accountId: accounts[2].id, debit: 100, credit: 0 },
            { accountId: accounts[0].id, debit: 0, credit: 100 },
            { accountId: accounts[1].id, debit: 70, credit: 0 },
            { accountId: accounts[2].id, debit: 0, credit: 70 },
          ],
        },
      },
    });
  });
  const data = await service.get(true, "2026-01-02", "2026-01-02");
  assert.equal(data.salesTrend.length, 1);
  assert.equal(data.salesTrend[0].date, "2026-01-02");
  assert.equal(
    Number(data.salesTrend[0].amount) -
      Number(before.salesTrend[0]?.amount ?? 0),
    100,
  );
  assert.equal(
    Number(data.salesTrend[0].grossProfit) -
      Number(before.salesTrend[0]?.grossProfit ?? 0),
    30,
  );
  assert.equal(
    Number(data.financials?.grossProfit) -
      Number(before.financials?.grossProfit),
    30,
  );
  assert.deepEqual(
    (await service.get(false, "2026-01-02", "2026-01-02")).salesTrend,
    [],
  );
});

test("unauthenticated business requests are denied; health connects to migrated PostgreSQL", async () => {
  await request(app.getHttpServer()).get("/api/v1/dashboard").expect(401);
  const response = await request(app.getHttpServer())
    .get("/api/v1/health")
    .expect(200);
  assert.equal(response.body.data.database, "connected");
});
test("login validates CSRF, Origin, DTO fields, and generic failure", async () => {
  const agent = request.agent(app.getHttpServer());
  await agent
    .post("/api/v1/auth/login")
    .set("Origin", origin())
    .send({ login: "owner", password })
    .expect(403);
  const token = await csrf(agent);
  await agent
    .post("/api/v1/auth/login")
    .set("Origin", "https://example.invalid")
    .set("X-CSRF-Token", token)
    .send({ login: "owner", password })
    .expect(403);
  await agent
    .post("/api/v1/auth/login")
    .set("Origin", origin())
    .set("X-CSRF-Token", token)
    .send({ login: "owner", password, roles: ["OWNER"] })
    .expect(400);
  const wrong = await agent
    .post("/api/v1/auth/login")
    .set("Origin", origin())
    .set("X-CSRF-Token", token)
    .send({ login: "unknown-" + id, password })
    .expect(401);
  assert.equal(wrong.body.error.message, "Invalid login or password.");
});
test("session and password secrets are hashed; user DTO has permission codes without hashes", async () => {
  const response = await owner.get("/api/v1/auth/me").expect(200);
  const user = response.body.data as CurrentUser;
  assert(user.permissions.includes("finance.read"));
  assert(!JSON.stringify(user).includes("passwordHash"));
  const stored = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  assert(stored.passwordHash.startsWith("$argon2id$"));
  assert.notEqual(stored.passwordHash, password);
  const sessions = await db.session.findMany({ where: { userId: ownerId } });
  assert(sessions.length > 0);
  assert.match(sessions[0].tokenHash, /^[a-f0-9]{64}$/);
});
test("finance data is omitted for sales staff and direct finance/users/settings access is denied", async () => {
  const response = await staff.get("/api/v1/dashboard").expect(200);
  assert(!Object.hasOwn(response.body.data, "financials"));
  assert.deepEqual(response.body.data.salesTrend, []);
  for (const route of [
    "/reports/financial-summary",
    "/users",
    "/roles",
    "/settings/shop",
    "/audit-logs",
    "/modules/accounts",
  ])
    await staff.get("/api/v1" + route).expect(403);
});
test("shop profile saves validated identity, preserves business defaults, and restricts writes", async () => {
  await db.applicationSetting.deleteMany({ where: { key: "shop" } });
  const save = async (agent: TestAgent, body: object) =>
    agent
      .post("/api/v1/settings/shop")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  const body = {
    name: "  Test Battery House  ",
    tagLine: "  Batteries and Auto Parts  ",
    tagLine2: "  " + "Authorized dealer ".repeat(40).trim() + "  ",
    address: "  Dhaka  ",
    phone: "  +8801700000000  ",
    version: 0,
  };
  await request(app.getHttpServer()).get("/api/v1/shop-profile").expect(401);
  assert.equal((await save(staff, body)).status, 403);
  await owner
    .post("/api/v1/settings/shop")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  assert.equal((await save(owner, { ...body, name: "   " })).status, 400);
  assert.equal(
    (await save(owner, { ...body, phone: "1".repeat(51) })).status,
    400,
  );
  assert.equal(
    (await save(owner, { ...body, tagLine: "x".repeat(1001) })).status,
    400,
  );
  assert.equal((await save(owner, { ...body, currency: "USD" })).status, 400);
  const created = await save(owner, body);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.version, 1);
  assert.deepEqual(created.body.data.value, {
    name: "Test Battery House",
    tagLine: "Batteries and Auto Parts",
    tagLine2: "Authorized dealer ".repeat(40).trim(),
    address: "Dhaka",
    phone: "+8801700000000",
    currency: "BDT",
    timezone: "Asia/Dhaka",
  });
  const updated = await save(owner, {
    ...body,
    name: "Updated Battery House",
    address: "",
    phone: "",
    version: 1,
  });
  assert.equal(updated.status, 201);
  assert.equal(updated.body.data.version, 2);
  assert.equal((await save(owner, body)).status, 409);
  const profile = await staff.get("/api/v1/shop-profile").expect(200);
  assert.deepEqual(profile.body.data, {
    name: "Updated Battery House",
    tagLine: "Batteries and Auto Parts",
    tagLine2: "Authorized dealer ".repeat(40).trim(),
    address: "",
    phone: "",
  });
  const stored = (await owner.get("/api/v1/settings/shop").expect(200)).body
    .data;
  assert.equal(stored.value.name, "Updated Battery House");
  assert.equal(stored.value.currency, "BDT");
  assert.equal(stored.value.timezone, "Asia/Dhaka");
  assert.equal(
    (await db.applicationSetting.findUniqueOrThrow({ where: { key: "shop" } }))
      .changedById,
    ownerId,
  );
  assert.equal(
    await db.auditLog.count({
      where: { action: "SHOP_PROFILE_UPDATED", actorId: ownerId },
    }),
    2,
  );
});

test("owner dashboard returns actual empty accounting totals and validates Dhaka date ranges", async () => {
  const response = await owner
    .get("/api/v1/dashboard?from=2026-11-01&to=2026-11-13")
    .expect(200);
  const data = response.body.data as DashboardData;
  assert.equal(data.financials?.todaySales, "0.00");
  assert.equal(data.from, "2026-11-01");
  await owner.get("/api/v1/dashboard?from=2026-02-31").expect(400);
  await owner
    .get("/api/v1/dashboard?from=2026-12-01&to=2026-11-01")
    .expect(400);
  assert.equal(
    businessRange("2026-11-13", "2026-11-13").start.toISOString(),
    "2026-11-12T18:00:00.000Z",
  );
});
test("session rotation revokes the prior token; logout requires CSRF and revokes the session", async () => {
  const agent = request.agent(app.getHttpServer());
  const first = await login(agent, "owner-" + id);
  assert.equal(first.status, 201);
  const rawCookie = (first.headers["set-cookie"] as unknown as string[]).find(
    (cookie) => cookie.startsWith(settings().cookieName + "="),
  )!;
  assert(rawCookie.includes("HttpOnly"));
  assert(rawCookie.includes("SameSite=Lax"));
  assert(rawCookie.includes("Path=/"));
  const raw = rawCookie.split(";")[0].slice(settings().cookieName.length + 1);
  assert.equal((await login(agent, "owner-" + id)).status, 201);
  assert(
    (await db.session.findUniqueOrThrow({ where: { tokenHash: digest(raw) } }))
      .revokedAt,
  );
  await agent
    .post("/api/v1/auth/logout")
    .set("Origin", origin())
    .send({})
    .expect(403);
  await agent
    .post("/api/v1/auth/logout")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(agent))
    .send({})
    .expect(201);
  await agent.get("/api/v1/auth/me").expect(401);
});
test("disabled users and expired/idle sessions cannot access the workspace", async () => {
  await db.user.update({ where: { id: staffId }, data: { active: false } });
  await staff.get("/api/v1/auth/me").expect(401);
  await db.user.update({ where: { id: staffId }, data: { active: true } });
  for (const expired of [false, true]) {
    const raw = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: staffId,
        tokenHash: digest(raw),
        csrfTokenHash: digest("unused"),
        createdAt: new Date(Date.now() - 3 * 3600000),
        lastSeenAt: new Date(Date.now() - 2 * 3600000),
        expiresAt: new Date(Date.now() + (expired ? -3600000 : 3600000)),
      },
    });
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", settings().cookieName + "=" + raw)
      .expect(401);
  }
});
test("permission changes are effective on the next request", async () => {
  const assignment = await db.userRole.findFirstOrThrow({
    where: { userId: staffId },
  });
  await db.userRole.delete({ where: { id: assignment.id } });
  await staff.get("/api/v1/dashboard").expect(403);
  await db.userRole.create({
    data: { userId: staffId, roleId: assignment.roleId },
  });
});
test("persistent login rate limiting returns 429 without disclosing account existence", async () => {
  const agent = request.agent(app.getHttpServer());
  const token = await csrf(agent);
  for (let i = 0; i < 10; i++)
    await agent
      .post("/api/v1/auth/login")
      .set("Origin", origin())
      .set("X-CSRF-Token", token)
      .send({ login: "limited-" + id, password })
      .expect(401);
  const response = await agent
    .post("/api/v1/auth/login")
    .set("Origin", origin())
    .set("X-CSRF-Token", token)
    .send({ login: "limited-" + id, password })
    .expect(429);
  assert.equal(response.headers["retry-after"], "900");
});
test("database rejects unbalanced journals, preserves balanced entries, and prevents audit mutation", async () => {
  const a = await db.account.create({
    data: { code: "test-a-" + id, name: "Isolated asset", kind: "ASSET" },
  });
  const b = await db.account.create({
    data: { code: "test-b-" + id, name: "Isolated equity", kind: "EQUITY" },
  });
  const source = "unbalanced-" + id;
  await assert.rejects(
    db.$transaction(async (tx) => {
      const posting = await tx.posting.create({
        data: { kind: "TEST", sourceCode: source, actorId: ownerId },
      });
      await tx.journalEntry.create({
        data: {
          postingId: posting.id,
          lines: {
            create: [
              { accountId: a.id, debit: "10", credit: "0" },
              { accountId: b.id, debit: "0", credit: "9" },
            ],
          },
        },
      });
    }),
  );
  assert.equal(await db.posting.count({ where: { sourceCode: source } }), 0);
  const balanced = await db.$transaction(async (tx) => {
    const posting = await tx.posting.create({
      data: { kind: "TEST", sourceCode: "balanced-" + id, actorId: ownerId },
    });
    return tx.journalEntry.create({
      data: {
        postingId: posting.id,
        lines: {
          create: [
            { accountId: a.id, debit: "10", credit: "0" },
            { accountId: b.id, debit: "0", credit: "10" },
          ],
        },
      },
    });
  });
  await assert.rejects(
    db.journalEntry.update({
      where: { id: balanced.id },
      data: { reason: "overwrite" },
    }),
  );
  const audit = await db.auditLog.findFirstOrThrow();
  await assert.rejects(db.auditLog.delete({ where: { id: audit.id } }));
});
test("database preserves repeated production dates, unique unit IDs, normalized serial uniqueness, and identity immutability", async () => {
  const type = await db.productType.create({
    data: {
      code: "test-battery-" + id,
      name: "Test battery",
      trackingKind: "BATTERY_UNIT",
    },
  });
  const brand = await db.brand.create({
    data: { name: "Isolated brand " + id, normalizedName: "isolated-" + id },
  });
  for (const method of ["PRODUCTION_DATE", "SERIAL"] as const) {
    const product = await db.product.create({
      data: {
        name: "Isolated test product",
        model: id,
        identityKey: method + id,
        unit: "piece",
        typeId: type.id,
        brandId: brand.id,
        batteryDetail: {
          create: {
            capacityAh: 100,
            voltage: 12,
            identificationMethod: method,
          },
        },
      },
    });
    const posting = await db.posting.create({
      data: {
        actorId: ownerId,
        kind: "TEST_OPENING",
        sourceCode: "opening-" + method + id,
      },
    });
    const opening = await db.openingBalance.create({
      data: {
        number: "open-" + method + id,
        postingId: posting.id,
        reason: "Isolated schema test",
        reconciliationReference: id,
      },
    });
    const item = await db.openingBalanceItem.create({
      data: {
        openingId: opening.id,
        deduplicationKey: "opening-item-" + method + id,
        kind: "STOCK",
        details: {},
      },
    });
    const batch = await db.stockBatch.create({
      data: {
        productId: product.id,
        origin: "OPENING",
        originalQuantity: 2,
        unitCost: 12000,
        openingItemId: item.id,
      },
    });
    const first = await db.batteryUnit.create({
      data: {
        productId: product.id,
        batchId: batch.id,
        internalCode: "unit-a-" + method + id,
        origin: "OPENING",
        productionDate: new Date("2026-10-01"),
        ...(method === "SERIAL" ? { serialNumber: "serial-" + id } : {}),
      },
    });
    if (method === "PRODUCTION_DATE") {
      const second = await db.batteryUnit.create({
        data: {
          productId: product.id,
          batchId: batch.id,
          internalCode: "unit-b-" + method + id,
          origin: "OPENING",
          productionDate: new Date("2026-10-01"),
        },
      });
      assert.notEqual(first.internalCode, second.internalCode);
      assert.equal(
        first.productionDate?.toISOString(),
        second.productionDate?.toISOString(),
      );
    } else
      await assert.rejects(
        db.batteryUnit.create({
          data: {
            productId: product.id,
            batchId: batch.id,
            internalCode: "unit-b-" + method + id,
            origin: "OPENING",
            serialNumber: " SERIAL-" + id.toUpperCase() + " ",
          },
        }),
      );
    await assert.rejects(
      db.batteryUnit.update({
        where: { id: first.id },
        data: { serialNumber: "rewritten" },
      }),
    );
    await assert.rejects(
      db.batteryUnit.update({
        where: { id: first.id },
        data: { commercialState: "AVAILABLE", condition: "FAULTY" },
      }),
    );
    await assert.rejects(
      db.inventoryBalance.create({
        data: {
          batchId: batch.id,
          location: "SHOP",
          bucket: "AVAILABLE",
          quantity: -1,
        },
      }),
    );
  }
});

test("replacement lineage can be created atomically without breaking the batch-unit-receipt foreign-key cycle", async () => {
  const type = await db.productType.create({
    data: {
      code: "lineage-type-" + id,
      name: "Isolated battery",
      trackingKind: "BATTERY_UNIT",
    },
  });
  const brand = await db.brand.create({
    data: { name: "Lineage test", normalizedName: "lineage-brand-" + id },
  });
  const product = await db.product.create({
    data: {
      name: "Lineage test battery",
      model: id,
      identityKey: "lineage-product-" + id,
      unit: "piece",
      typeId: type.id,
      brandId: brand.id,
      batteryDetail: {
        create: {
          capacityAh: 100,
          voltage: 12,
          identificationMethod: "PRODUCTION_DATE",
        },
      },
    },
  });
  const opening = await db.openingBalance.create({
    data: {
      number: "lineage-open-" + id,
      reason: "Isolated schema fixture",
      reconciliationReference: id,
      posting: {
        create: {
          actorId: ownerId,
          kind: "TEST",
          sourceCode: "lineage-open-post-" + id,
        },
      },
      items: {
        create: {
          kind: "STOCK",
          deduplicationKey: "lineage-open-item-" + id,
          details: {},
        },
      },
    },
    include: { items: true },
  });
  const oldBatch = await db.stockBatch.create({
    data: {
      productId: product.id,
      origin: "OPENING",
      originalQuantity: 1,
      unitCost: 12000,
      openingItemId: opening.items[0].id,
    },
  });
  const oldUnit = await db.batteryUnit.create({
    data: {
      productId: product.id,
      batchId: oldBatch.id,
      origin: "OPENING",
      internalCode: "lineage-old-" + id,
      productionDate: new Date("2026-10-01"),
      condition: "FAULTY",
      custody: "SUPPLIER",
    },
  });
  const supplier = await db.supplier.create({
    data: { name: "Isolated lineage supplier " + id },
  });
  const replacement = await db.replacementRecord.create({
    data: {
      number: "lineage-claim-" + id,
      source: "BEFORE_SALE",
      status: "SENT_TO_COMPANY",
      faultReason: "Isolated schema fixture",
      oldUnitId: oldUnit.id,
      supplierId: supplier.id,
    },
  });
  const dispatch = await db.replacementDispatch.create({
    data: {
      number: "lineage-dispatch-" + id,
      supplier: { connect: { id: supplier.id } },
      dispatchDate: new Date("2026-11-01"),
      snapshot: {},
      posting: {
        create: {
          actorId: ownerId,
          kind: "TEST",
          sourceCode: "lineage-dispatch-post-" + id,
        },
      },
      items: {
        create: { replacementId: replacement.id, oldUnitId: oldUnit.id },
      },
    },
    include: { items: true },
  });
  const receipt = await db.replacementReceipt.create({
    data: {
      number: "lineage-receipt-" + id,
      supplier: { connect: { id: supplier.id } },
      receivedDate: new Date("2026-11-13"),
      posting: {
        create: {
          actorId: ownerId,
          kind: "TEST",
          sourceCode: "lineage-receipt-post-" + id,
        },
      },
    },
  });
  const itemId = randomUUID();
  await db.$transaction(async (tx) => {
    const batch = await tx.stockBatch.create({
      data: {
        productId: product.id,
        origin: "REPLACEMENT",
        originalQuantity: 1,
        unitCost: 12000,
        replacementReceiptItemId: itemId,
      },
    });
    const newUnit = await tx.batteryUnit.create({
      data: {
        productId: product.id,
        batchId: batch.id,
        origin: "REPLACEMENT",
        internalCode: "lineage-new-" + id,
        productionDate: new Date("2026-11-01"),
      },
    });
    await tx.replacementReceiptItem.create({
      data: {
        id: itemId,
        receiptId: receipt.id,
        replacementId: replacement.id,
        dispatchItemId: dispatch.items[0].id,
        oldUnitId: oldUnit.id,
        newUnitId: newUnit.id,
        inheritedUnitCost: 12000,
        policySnapshot: {},
      },
    });
    await tx.batteryUnit.update({
      where: { id: oldUnit.id },
      data: { commercialState: "RETIRED" },
    });
    await tx.replacementRecord.update({
      where: { id: replacement.id },
      data: { status: "REPLACEMENT_RECEIVED" },
    });
    await tx.dispatchItem.update({
      where: { id: dispatch.items[0].id },
      data: { returnedAt: new Date() },
    });
  });
  const lineage = await db.replacementReceiptItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { oldUnit: true, newUnit: { include: { batch: true } } },
  });
  assert.notEqual(lineage.newUnit.id, lineage.oldUnit.id);
  assert.equal(
    lineage.oldUnit.productionDate?.toISOString(),
    oldUnit.productionDate?.toISOString(),
  );
  assert.equal(lineage.newUnit.batch.replacementReceiptItemId, itemId);
  assert.equal(lineage.newUnit.commercialState, "UNAVAILABLE");
  assert.equal(lineage.newUnit.condition, "PENDING_INSPECTION");
});

test("only three permanent categories are offered and owners cannot create or delete them", async () => {
  const metadata = (await owner.get("/api/v1/catalog").expect(200)).body.data;
  assert.deepEqual(
    metadata.types.map((type: { name: string }) => type.name),
    ["Battery", "Parts", "Easy Bike & Rickshaw"],
  );
  const count = await db.productType.count();
  await owner
    .post("/api/v1/product-types")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ name: "Custom category", trackingKind: "QUANTITY" })
    .expect(409);
  for (const type of metadata.types) {
    await owner
      .delete("/api/v1/product-types/" + type.id)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send({ confirmed: true })
      .expect(409);
    assert(await db.productType.findUnique({ where: { id: type.id } }));
  }
  assert.equal(await db.productType.count(), count);
  const vehicleType = metadata.types.find(
    (type: { name: string }) => type.name === "Easy Bike & Rickshaw",
  );
  const vehicle = await owner
    .post("/api/v1/products")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({
      typeId: vehicleType.id,
      name: "Rickshaw " + id,
      category: "Rickshaw " + id,
      unit: "pcs",
      specifications: "Electric rickshaw",
    })
    .expect(201);
  assert.equal(vehicle.body.data.type.trackingKind, "QUANTITY");
  assert.equal(vehicle.body.data.type.id, vehicleType.id);
  assert.equal(vehicle.body.data.stock.total, "0");
  // Old types remain available to historical transactions but cannot receive new products/names.
  const legacy = await db.productType.create({
    data: { code: "legacy-" + id, name: "Legacy", trackingKind: "QUANTITY" },
  });
  for (const [route, body] of [
    ["categories", { typeId: legacy.id, name: "Blocked name" }],
    [
      "products",
      {
        typeId: legacy.id,
        name: "Blocked product",
        unit: "pcs",
        category: "Blocked name",
      },
    ],
  ] as const) {
    await owner
      .post("/api/v1/" + route)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(body)
      .expect(400);
  }
});

test("purchase receiving posts exact stock, costs and supplier payment once; invalid purchases leave no partial records", async () => {
  const write = async (route: string, body: object) =>
    owner
      .post("/api/v1/" + route)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(body)
      .expect(201);
  for (const [code, name, kind, paymentMethod] of [
    ["1300", "Inventory", "ASSET", null],
    ["2100", "Supplier payables", "LIABILITY", null],
    ["1100", "Cash", "ASSET", "CASH"],
  ] as const)
    await db.account.upsert({
      where: { code },
      update: { active: true },
      create: { code, name, kind, paymentMethod },
    });
  const cash = await db.account.findUniqueOrThrow({ where: { code: "1100" } });
  const supplier = await db.supplier.create({
    data: {
      name: "Receiving supplier " + id,
      company: "Receiving company " + id,
      productType: { connect: { code: "BATTERY" } },
    },
  });
  const quantityType = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const unitType = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const emptyType = await db.productType.findUniqueOrThrow({
    where: { code: "EASY_BIKE_RICKSHAW" },
  });
  const inactiveType = await db.productType.create({
    data: {
      code: "purchase-inactive-" + id,
      name: "Purchase inactive " + id,
      trackingKind: "QUANTITY",
      active: false,
    },
  });
  const part = (
    await write("products", {
      typeId: quantityType.id,
      name: "Purchase nut " + id,
      unit: "piece",
      category: "Purchase fittings " + id,
    })
  ).body.data;
  const battery = (
    await write("products", {
      typeId: unitType.id,
      name: "Purchase unit " + id,
      unit: "piece",
      brand: "Purchase maker " + id,
      capacityAh: "100",
      voltage: "12",
      model: "Test model",
    })
  ).body.data;
  assert.equal(
    await db.stockBatch.count({
      where: { productId: { in: [part.id, battery.id] } },
    }),
    0,
  );
  await request(app.getHttpServer())
    .get("/api/v1/purchases/options")
    .expect(401);
  await staff.get("/api/v1/purchases/options").expect(403);
  const purchaseName = await db.category.create({
    data: {
      name: "Purchase name " + id,
      normalizedName: "purchase name " + id,
      types: { create: { typeId: unitType.id } },
    },
  });
  const options = (await owner.get("/api/v1/purchases/options").expect(200))
    .body.data;
  assert.deepEqual(
    options.productNames.filter(
      (name: { id: string }) => name.id === purchaseName.id,
    ),
    [{ id: purchaseName.id, name: purchaseName.name, typeId: unitType.id }],
  );
  const fixtureTypeIds = [unitType.id, emptyType.id, quantityType.id];
  assert.deepEqual(
    options.types.filter((type: { id: string }) =>
      fixtureTypeIds.includes(type.id),
    ),
    [unitType, quantityType, emptyType].map(({ id, name, trackingKind }) => ({
      id,
      name,
      trackingKind,
    })),
  );
  assert.equal(
    options.types.some((type: { id: string }) => type.id === inactiveType.id),
    false,
  );
  assert(
    options.products.some(
      (product: { id: string }) => product.id === battery.id,
    ),
  );
  assert(
    options.suppliers.some((item: { id: string }) => item.id === supplier.id),
  );
  const partsSupplier = await db.supplier.create({
    data: {
      name: "Parts receiving supplier " + id,
      productTypeId: quantityType.id,
    },
  });
  const body = {
    supplierId: supplier.id,
    purchaseDate: "2025-06-01",
    reference: "Receipt " + id,
    items: [
      {
        productId: battery.id,
        quantity: 2,
        unitPrice: "1000.10",
      },
    ],
    paidAmount: "500.05",
    paymentAccountId: cash.id,
  };
  const receive = async (payload: object, key = randomUUID()) =>
    owner
      .post("/api/v1/purchases/receive")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .set("Idempotency-Key", key)
      .send(payload);
  await request(app.getHttpServer())
    .post("/api/v1/purchases/receive")
    .set("Origin", origin())
    .send(body)
    .expect(401);
  await staff
    .post("/api/v1/purchases/receive")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .set("Idempotency-Key", randomUUID())
    .send(body)
    .expect(403);
  await owner
    .post("/api/v1/purchases/receive")
    .set("Origin", origin())
    .set("Idempotency-Key", randomUUID())
    .send(body)
    .expect(403);
  await owner
    .post("/api/v1/purchases/receive")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send(body)
    .expect(400);
  const before = await db.purchase.count();
  for (const invalid of [
    {
      ...body,
      items: [{ productId: part.id, quantity: 3, unitPrice: "12.25" }],
    },
    { ...body, supplierId: partsSupplier.id },
    { ...body, discount: "1" },
    { ...body, reference: undefined },
    { ...body, reference: "" },
    { ...body, reference: "   " },
    { ...body, purchaseDate: "2025-02-31" },
    { ...body, supplierId: randomUUID() },
    { ...body, paidAmount: "999999.00" },
    { ...body, items: [{ ...body.items[0], quantity: 0 }] },
    { ...body, items: [{ ...body.items[0], unitPrice: "100000000000000.00" }] },
    {
      ...body,
      items: [
        {
          ...body.items[0],
          identities: [{ serialNumber: "Missing-date" + id }],
        },
      ],
    },
    {
      ...body,
      items: [
        {
          ...body.items[0],
          identities: [
            { serialNumber: "DUPLICATE-" + id, productionDate: "2025-05-01" },
            {
              serialNumber: " duplicate-" + id.toUpperCase() + " ",
              productionDate: "2025-05-01",
            },
          ],
        },
      ],
    },
  ]) {
    const response = await receive(invalid);
    assert([400, 409].includes(response.status), JSON.stringify(response.body));
  }
  assert.equal(await db.purchase.count(), before);
  const key = randomUUID();
  const concurrent = await Promise.all([
    receive(body, key),
    receive(body, key),
  ]);
  for (const response of concurrent)
    assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(concurrent[0].body, concurrent[1].body);
  assert(
    concurrent.some(
      (response) => response.headers["idempotency-replayed"] === "true",
    ),
  );
  const result = concurrent[0].body.data;
  assert.match(result.number, /^PUR-\d{6}$/);
  assert.equal(result.total, "2000.20");
  assert.equal(result.paid, "500.05");
  assert.equal(result.due, "1500.15");
  assert.equal(result.quantity, 2);
  assert.equal(await db.purchase.count(), before + 1);
  const receipt = await db.purchaseReceipt.findUniqueOrThrow({
    where: { id: result.receiptId },
    include: {
      items: {
        include: { batch: { include: { balances: true, batteryUnits: true } } },
      },
      posting: {
        include: {
          movements: true,
          journal: { include: { lines: { include: { account: true } } } },
        },
      },
      paymentAllocations: {
        include: {
          payment: { include: { journal: { include: { lines: true } } } },
        },
      },
    },
  });
  assert.equal(receipt.items.length, 1);
  const partsReceived = await receive({
    supplierId: partsSupplier.id,
    purchaseDate: body.purchaseDate,
    reference: "Parts receipt " + id,
    items: [{ productId: part.id, quantity: 3, unitPrice: "12.25" }],
    paidAmount: "0.00",
  });
  assert.equal(partsReceived.status, 201, JSON.stringify(partsReceived.body));
  assert.equal(partsReceived.body.data.total, "36.75");
  const partBatch = await db.stockBatch.findFirstOrThrow({
    where: { productId: part.id },
    include: { balances: true },
  });
  const unitBatch = receipt.items.find(
    (item) => item.batch?.productId === battery.id,
  )!.batch!;
  assert.equal(partBatch.unitCost.toFixed(2), "12.25");
  assert.equal(partBatch.balances[0].quantity.toString(), "3");
  assert.equal(unitBatch.unitCost.toFixed(2), "1000.10");
  assert.equal(unitBatch.batteryUnits.length, 2);
  assert(
    unitBatch.batteryUnits.every(
      (unit) =>
        unit.condition === "GOOD" &&
        unit.commercialState === "AVAILABLE" &&
        unit.custody === "SHOP",
    ),
  );
  assert.notEqual(
    unitBatch.batteryUnits[0].internalCode,
    unitBatch.batteryUnits[1].internalCode,
  );
  assert.equal(receipt.posting.movements.length, 2);
  const inventoryLine = receipt.posting.journal!.lines.find(
    (line) => line.account.code === "1300",
  )!;
  const payableLine = receipt.posting.journal!.lines.find(
    (line) => line.account.code === "2100",
  )!;
  assert.equal(inventoryLine.debit.toFixed(2), "2000.20");
  assert.equal(payableLine.credit.toFixed(2), "2000.20");
  assert.equal(payableLine.supplierId, supplier.id);
  assert.equal(receipt.paymentAllocations[0].amount.toFixed(2), "500.05");
  assert.equal(receipt.paymentAllocations[0].payment.assetAccountId, cash.id);
  assert.equal(receipt.paymentAllocations[0].payment.journal.lines.length, 2);
  assert(
    await db.auditLog.findFirst({
      where: { action: "PURCHASE_RECEIVE", resourceId: result.id },
    }),
  );
  const stock = (
    await owner.get("/api/v1/products?typeId=" + quantityType.id).expect(200)
  ).body.data.items[0].stock;
  assert.equal(stock.total, "3");
  assert.equal(stock.available, "3");
  const unitStock = (
    await owner.get("/api/v1/products?typeId=" + unitType.id).expect(200)
  ).body.data.items[0].stock;
  assert.equal(Number(unitStock.total), 2);
  assert.equal(Number(unitStock.available), 2);
  const listing = (
    await owner.get("/api/v1/purchases?pageSize=100").expect(200)
  ).body.data;
  const detailedPurchase = listing.items.find(
    (item: { id: string }) => item.id === result.id,
  );
  assert.equal(detailedPurchase.items.length, 1);
  assert.equal(detailedPurchase.items[0].quantity, "2");
  assert.equal(detailedPurchase.items[0].total, "2000.20");
  assert.equal(typeof detailedPurchase.items[0].model, "string");
  assert.equal(typeof detailedPurchase.items[0].warrantyMonths, "number");
  assert.equal(
    listing.items.find((item: { id: string }) => item.id === result.id).due,
    "1500.15",
  );
  await request(app.getHttpServer())
    .get("/api/v1/purchases/recent")
    .expect(401);
  await staff.get("/api/v1/purchases/recent").expect(403);
  const recent = (await owner.get("/api/v1/purchases/recent").expect(200)).body
    .data;
  assert(recent.items.length <= 10);
  assert.equal(recent.items[0].id, partsReceived.body.data.id);
  const recentBattery = recent.items.find(
    (item: { id: string }) => item.id === result.id,
  );
  assert(recentBattery);
  assert.equal(recentBattery.purchaseDate, body.purchaseDate);
  assert.equal(recentBattery.supplierReference, body.reference);
  assert.deepEqual(recentBattery.supplier, {
    name: supplier.name,
    company: supplier.company,
  });
  assert.equal(recentBattery.items[0].name, battery.name);
  assert.equal(recentBattery.items[0].model, battery.model);
  assert.equal(recentBattery.items[0].capacityAh, "100");
  assert.equal(recentBattery.items[0].voltage, "12");
  assert.equal(recentBattery.items[0].quantity, "2");
  assert.equal(recentBattery.items[0].unitPrice, "1000.10");
  assert.equal(recentBattery.items[0].total, "2000.20");
  assert.equal(
    (await receive({ ...body, paidAmount: "500.00" }, key)).status,
    409,
  );
  // Removed serial input is rejected without adding stock or a purchase.
  const duplicate = await receive({
    ...body,
    items: [
      {
        ...body.items[0],
        quantity: 1,
        identities: [{ serialNumber: "LEGACY-SERIAL" }],
      },
    ],
  });
  assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body));
  assert.equal(await db.purchase.count(), before + 2);
  assert.equal(await db.stockBatch.count({ where: { productId: part.id } }), 1);
  assert.equal(
    await db.batteryUnit.count({ where: { productId: battery.id } }),
    2,
  );
  // Transport is a separate cash expense, with the same retry and reversal guarantees.
  for (const transportAmount of ["-1", "1.001", "100000000000000.00"])
    assert.equal((await receive({ ...body, transportAmount })).status, 400);
  assert.equal(
    (
      await receive({
        ...body,
        paidAmount: "0.00",
        transportAmount: "25.50",
        paymentAccountId: undefined,
      })
    ).status,
    400,
  );
  const transportKey = randomUUID();
  const transportBody = {
    ...body,
    paidAmount: "0.00",
    transportAmount: "25.50",
  };
  const transportPurchase = (await receive(transportBody, transportKey)).body
    .data;
  assert.equal(transportPurchase.transportAmount, "25.50");
  assert.equal(transportPurchase.due, "2000.20");
  assert.equal((await receive(transportBody, transportKey)).status, 201);
  const transportJournal = await db.journalEntry.findFirstOrThrow({
    where: { posting: { sourceCode: "purchase:" + transportPurchase.id } },
    include: { lines: { include: { account: true } } },
  });
  const transportLine = transportJournal.lines.find(
    (line) => line.account.code === "5200",
  )!;
  assert.equal(transportLine.debit.toFixed(2), "25.50");
  assert.equal(
    transportJournal.lines
      .find((line) => line.accountId === cash.id)!
      .credit.toFixed(2),
    "25.50",
  );
  const reportPath =
    "/api/v1/reports/financial-summary?from=2025-06-01&to=2025-06-01";
  const report = (await owner.get(reportPath).expect(200)).body.data;
  assert(
    report.transportTransactions.some(
      (line: { id: string }) => line.id === transportLine.id,
    ),
  );
  assert.equal(report.transportExpenses, "25.50");
  const companyPayment = report.companyTransactions.find(
    (line: { id: string }) =>
      line.id === receipt.paymentAllocations[0].payment.id,
  );
  assert(companyPayment);
  assert.equal(
    report.companyTransactionCount,
    report.companyTransactions.length,
  );
  assert.equal(
    companyPayment.company,
    supplier.company?.trim() || supplier.name,
  );
  assert.equal(companyPayment.amount, "500.05");
  assert.equal(companyPayment.type, "Payment");
  assert.equal(companyPayment.challanNumber, body.reference);
  const validPayments = await db.payment.findMany({
    where: {
      supplierId: { not: null },
      reversedPaymentId: null,
      reversal: { is: null },
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  assert.deepEqual(
    report.companyTransactions.map((line: { id: string }) => line.id),
    validPayments.map((payment) => payment.id),
  );
  assert.equal(
    report.transportTransactions.find(
      (line: { id: string }) => line.id === transportLine.id,
    ).challanNumber,
    body.reference,
  );
  const expenseRows = (
    await owner.get("/api/v1/expenses").query({ pageSize: 100 }).expect(200)
  ).body.data.items;
  assert.equal(
    expenseRows.find((line: { id: string }) => line.id === transportLine.id)
      .challanNumber,
    body.reference,
  );
  await owner
    .delete("/api/v1/purchases/" + transportPurchase.id)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true, reason: "Transport reversal test" })
    .expect(200);
  const reversal = await db.journalEntry.findUniqueOrThrow({
    where: { reversedEntryId: transportJournal.id },
    include: { lines: true },
  });
  assert.equal(
    reversal.lines
      .find((line) => line.accountId === transportLine.accountId)!
      .credit.toFixed(2),
    "25.50",
  );
  const afterTransport = (await owner.get(reportPath).expect(200)).body.data;
  assert.equal(afterTransport.transportExpenses, "0.00");
  assert(
    !afterTransport.transportTransactions.some(
      (line: { id: string }) => line.id === transportLine.id,
    ),
  );
});

test("receiving without finance permission accepts due stock without product identification but rejects payments", async () => {
  const type = await db.productType.findFirstOrThrow({
    where: { code: "BATTERY" },
  });
  const supplier = await db.supplier.findFirstOrThrow({
    where: { name: "Receiving supplier " + id },
  });
  const response = await owner
    .post("/api/v1/products")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({
      typeId: type.id,
      name: "Date units " + id,
      unit: "piece",
      brand: "Purchase maker " + id,
      capacityAh: "80",
      voltage: "12",
      model: "Test model",
    })
    .expect(201);
  const productId = response.body.data.id;
  const codes = ["purchases.manage", "inventory.receive"];
  const role = await db.role.create({
    data: {
      code: "receiving-test-" + id,
      name: "Isolated receiver",
      permissions: {
        create: codes.map((code) => ({ permission: { connect: { code } } })),
      },
    },
  });
  const loginName = "receiver-test-" + id;
  await db.user.create({
    data: {
      login: loginName,
      name: "Isolated receiver",
      passwordHash: await hash(password, passwordOptions),
      roles: { create: { roleId: role.id } },
    },
  });
  const receiver = request.agent(app.getHttpServer());
  assert.equal((await login(receiver, loginName)).status, 201);
  const body = {
    supplierId: supplier.id,
    purchaseDate: "2025-06-01",
    reference: "Receiver receipt " + id,
    items: [
      {
        productId,
        quantity: 2,
        unitPrice: "0.00",
      },
    ],
  };
  const send = async (payload: object) =>
    receiver
      .post("/api/v1/purchases/receive")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(receiver))
      .set("Idempotency-Key", randomUUID())
      .send(payload);
  assert.equal((await send({ ...body, paidAmount: "1.00" })).status, 403);
  const received = await send(body);
  assert.equal(received.status, 201, JSON.stringify(received.body));
  assert.equal(received.body.data.total, "0.00");
  assert.equal(received.body.data.due, "0.00");
  const units = await db.batteryUnit.findMany({ where: { productId } });
  assert.equal(units.length, 2);
  assert.equal(
    units[0].productionDate?.toISOString(),
    units[1].productionDate?.toISOString(),
  );
  assert.notEqual(units[0].internalCode, units[1].internalCode);
  const receipt = await db.purchaseReceipt.findUniqueOrThrow({
    where: { id: received.body.data.receiptId },
    include: { posting: { include: { journal: true } } },
  });
  assert.equal(receipt.posting.journal, null);
});

test("customers persist contacts without vehicle data, with validation, audit and access checks", async () => {
  const body = {
    name: "Shared customer " + id,
    phone: "+8801712345678",
    address: "Dhaka",
  };
  await request(app.getHttpServer()).get("/api/v1/customers").expect(401);
  await staff
    .post("/api/v1/customers")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  const write = async (payload: object) =>
    staff
      .post("/api/v1/customers")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(staff))
      .send(payload);
  assert.equal((await write({ ...body, phone: "bad" })).status, 400);
  for (const address of [undefined, null, "", "   ", "x".repeat(501)]) {
    assert.equal((await write({ ...body, address })).status, 400);
  }
  assert.equal((await write({ ...body, active: false })).status, 400);
  assert.equal((await write({ ...body, vehicleType: "" })).status, 400);
  assert.equal(
    (await write({ ...body, vehicleType: "Easy Bike" })).status,
    400,
  );
  assert.equal(
    (await write({ ...body, vehicleIdentifier: "VEH-" + id })).status,
    400,
  );
  const created = await write(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const customer = created.body.data;
  assert.equal(customer.totalSales, "0.00");
  assert.equal(customer.due, "0.00");
  assert.equal(Object.hasOwn(customer, "vehicles"), false);
  const stored = await db.customer.findUniqueOrThrow({
    where: { id: customer.id },
  });
  assert.equal(stored.name, body.name);
  const removedTables = await db.$queryRaw<{ tableName: string }[]>`
    SELECT table_name AS "tableName" FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('Vehicle', 'BatterySet')
  `;
  assert.deepEqual(removedTables, []);
  assert.equal(
    await db.auditLog.count({
      where: {
        action: "CUSTOMER_CREATED",
        resourceId: customer.id,
        actorId: staffId,
      },
    }),
    1,
  );
  const listed = await owner
    .get("/api/v1/customers")
    .query({ q: body.name, status: "active", credit: "clear" })
    .expect(200);
  assert.deepEqual(
    listed.body.data.items.map((item: { id: string }) => item.id),
    [customer.id],
  );
  assert.equal(listed.body.data.summary.total >= 1, true);
  await owner.get("/api/v1/customers").query({ pageSize: 101 }).expect(400);
});

test("sales atomically consume FIFO stock, preserve warranty, post exact payments and customer dues, and replay once", async () => {
  for (const [code, name, kind, paymentMethod] of [
    ["1200", "Customer receivables", "ASSET", null],
    ["1300", "Inventory", "ASSET", null],
    ["2100", "Supplier payable", "LIABILITY", null],
    ["4100", "Sales revenue", "REVENUE", null],
    ["5100", "Cost of goods sold", "EXPENSE", null],
    ["1100", "Cash", "ASSET", "CASH"],
  ] as const)
    await db.account.upsert({
      where: { code },
      update: { active: true },
      create: { code, name, kind, paymentMethod },
    });
  const cash = await db.account.findUniqueOrThrow({ where: { code: "1100" } });
  const write = async (route: string, body: object) =>
    owner
      .post("/api/v1/" + route)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(body)
      .expect(201);
  const customer = (
    await write("customers", {
      name: "Sale customer " + id,
      phone: "01700000000",
      address: "Dhaka",
    })
  ).body.data;
  const quantityType = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const unitType = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const emptyType = await db.productType.findUniqueOrThrow({
    where: { code: "EASY_BIKE_RICKSHAW" },
  });
  const part = (
    await write("products", {
      typeId: quantityType.id,
      name: "Sale nut " + id,
      unit: "piece",
      category: "Sale fittings " + id,
      defaultSellingPrice: "20.25",
    })
  ).body.data;
  const battery = (
    await write("products", {
      typeId: unitType.id,
      name: "Sale battery " + id,
      unit: "piece",
      brand: "Sale maker " + id,
      capacityAh: "100",
      voltage: "12",
      model: "Test model",
      warrantyMonths: 1,
      defaultSellingPrice: "150.10",
    })
  ).body.data;
  const supplier = await db.supplier.create({
    data: { name: "Sale fixture supplier " + id, productTypeId: unitType.id },
  });
  const partsSupplier = await db.supplier.create({
    data: { name: "Sale parts supplier " + id, productTypeId: quantityType.id },
  });
  const receive = async (
    purchaseDate: string,
    items: {
      productId: string;
      quantity: number;
      unitPrice: string;
      identities?: { serialNumber: string; productionDate: string }[];
    }[],
  ) => {
    for (const [productId, supplierId] of [
      [part.id, partsSupplier.id],
      [battery.id, supplier.id],
    ]) {
      const categoryItems = items.filter(
        (item) => item.productId === productId,
      );
      if (!categoryItems.length) continue;
      await owner
        .post("/api/v1/purchases/receive")
        .set("Origin", origin())
        .set("X-CSRF-Token", await csrf(owner))
        .set("Idempotency-Key", randomUUID())
        .send({
          supplierId,
          purchaseDate,
          reference: "Sale fixture " + id,
          items: categoryItems,
        })
        .expect(201);
    }
  };
  await receive("2025-01-01", [
    { productId: part.id, quantity: 2, unitPrice: "10.10" },
    {
      productId: battery.id,
      quantity: 2,
      unitPrice: "100.20",
    },
  ]);
  await receive("2025-01-02", [
    { productId: part.id, quantity: 3, unitPrice: "12.25" },
  ]);
  const units = await db.batteryUnit.findMany({
    where: { productId: battery.id },
    orderBy: { id: "asc" },
  });
  await request(app.getHttpServer()).get("/api/v1/sales/options").expect(401);
  const before = await staff.get("/api/v1/sales/options").expect(200);
  assert(
    before.body.data.types.some(
      (type: { id: string }) => type.id === emptyType.id,
    ),
  );
  assert.equal(
    before.body.data.products.find(
      (product: { id: string }) => product.id === part.id,
    ).availableQuantity,
    "5",
  );
  assert.equal(
    before.body.data.products.find(
      (product: { id: string }) => product.id === battery.id,
    ).availableQuantity,
    "2",
  );
  assert(
    before.body.data.customers.some(
      (item: { id: string }) => item.id === customer.id,
    ),
  );
  const body = {
    customerId: customer.id,
    saleDate: "2025-01-31",
    notes: "Shared sale",
    items: [
      { productId: part.id, quantity: 3, unitPrice: "20.25" },
      {
        productId: battery.id,
        quantity: 1,
        unitPrice: "150.10",
      },
    ],
    paidAmount: "100.05",
    paymentAccountId: cash.id,
  };
  const complete = async (payload: object, key = randomUUID(), agent = staff) =>
    agent
      .post("/api/v1/sales/complete")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .set("Idempotency-Key", key)
      .send(payload);
  await staff
    .post("/api/v1/sales/complete")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  const key = randomUUID();
  const first = await complete(body, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.total, "210.85");
  assert.match(first.body.data.invoiceNumber, /^HB-\d{4}$/);
  assert.equal(first.body.data.paid, "100.05");
  assert.equal(first.body.data.due, "110.80");
  assert.equal(first.body.data.quantity, 4);
  const replay = await complete(body, key);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(
    (await complete({ ...body, notes: "Changed" }, key)).status,
    409,
  );
  const sale = await db.sale.findUniqueOrThrow({
    where: { id: key },
    include: {
      items: { include: { costAllocations: true, units: true } },
      posting: {
        include: {
          journal: { include: { lines: { include: { account: true } } } },
        },
      },
      paymentAllocations: { include: { payment: true } },
    },
  });
  const partLine = sale.items.find((item) => item.productId === part.id)!;
  assert.equal(partLine.costAllocations.length, 2);
  assert.equal(partLine.costTotal.toFixed(2), "32.45");
  const batteryLine = sale.items.find((item) => item.productId === battery.id)!;
  assert.equal(batteryLine.costTotal.toFixed(2), "100.20");
  assert.equal(
    batteryLine.units[0].coverageStart.toISOString().slice(0, 10),
    "2025-01-31",
  );
  assert.equal(
    batteryLine.units[0].coverageExpiry.toISOString().slice(0, 10),
    "2025-02-28",
  );
  const sold = await db.batteryUnit.findUniqueOrThrow({
    where: { id: units[0].id },
  });
  assert.deepEqual(
    [sold.custody, sold.ownership, sold.commercialState],
    ["CUSTOMER", "CUSTOMER", "SOLD"],
  );
  const journal = sale.posting!.journal!.lines;
  const amount = (code: string, side: "debit" | "credit") =>
    journal
      .filter((line) => line.account.code === code)
      .reduce((sum, line) => sum + Number(line[side]), 0)
      .toFixed(2);
  assert.equal(amount("1200", "debit"), "210.85");
  assert.equal(amount("4100", "credit"), "210.85");
  assert.equal(amount("5100", "debit"), "132.65");
  assert.equal(amount("1300", "credit"), "132.65");
  assert.equal(sale.paymentAllocations[0].payment.amount.toFixed(2), "100.05");
  assert.equal(
    await db.stockMovement.count({ where: { postingId: sale.postingId! } }),
    3,
  );
  assert.equal(
    await db.auditLog.count({
      where: { resourceId: key, action: "SALE_COMPLETE" },
    }),
    1,
  );
  const contacts = (
    await owner
      .get("/api/v1/customers")
      .query({ q: customer.name, credit: "due" })
      .expect(200)
  ).body.data;
  assert.equal(contacts.items[0].due, "110.80");
  assert.equal(contacts.items[0].totalSales, "210.85");
  const listed = (
    await staff
      .get("/api/v1/sales")
      .query({ q: first.body.data.invoiceNumber, status: "due" })
      .expect(200)
  ).body.data;
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].due, "110.80");
  assert.equal(listed.items[0].quantity, "4");
  const stock = () =>
    db.inventoryBalance.aggregate({
      where: { batch: { productId: part.id } },
      _sum: { quantity: true },
    });
  assert.equal((await stock())._sum.quantity?.toString(), "2");
  const saleCount = await db.sale.count();
  const invalid = await complete({
    ...body,
    items: [
      { productId: part.id, quantity: 1, unitPrice: "20.25" },
      {
        productId: battery.id,
        quantity: 1,
        unitPrice: "150.10",
        batteryUnitIds: [units[0].id],
      },
    ],
    paidAmount: "0.00",
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(await db.sale.count(), saleCount);
  assert.equal((await stock())._sum.quantity?.toString(), "2");
  assert.equal((await complete({ ...body, paidAmount: "999.00" })).status, 400);
  for (const unitPrice of [undefined, "", "0", "0.00", "-1.00"]) {
    assert.equal(
      (
        await complete({
          ...body,
          items: [{ productId: part.id, quantity: 1, unitPrice }],
        })
      ).status,
      400,
    );
  }
  assert.equal(await db.sale.count(), saleCount);
  assert.equal(
    (await complete({ ...body, saleDate: "2025-02-30" })).status,
    400,
  );
  assert.equal(
    (
      await complete({
        ...body,
        items: [{ productId: part.id, quantity: 1, unitPrice: "0.001" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await complete({ ...body, items: [body.items[0], body.items[0]] })).status,
    400,
  );
  // Competing requests cannot consume the same last quantity or battery twice.
  const lastParts = {
    customerId: customer.id,
    saleDate: "2025-01-31",
    items: [{ productId: part.id, quantity: 2, unitPrice: "20.25" }],
    paidAmount: "0.00",
  };
  const races = await Promise.all([complete(lastParts), complete(lastParts)]);
  assert.deepEqual(races.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await stock())._sum.quantity?.toString(), "0");
  const lastBattery = {
    customerId: customer.id,
    saleDate: "2025-01-31",
    items: [{ productId: battery.id, quantity: 1, unitPrice: "150.10" }],
    paidAmount: "0.00",
  };
  const batteryRaces = await Promise.all([
    complete(lastBattery),
    complete(lastBattery),
  ]);
  assert.deepEqual(
    batteryRaces.map((response) => response.status).sort(),
    [201, 409],
  );
  const invoices = [first, ...races, ...batteryRaces]
    .filter((response) => response.status === 201)
    .map((response) => response.body.data.invoiceNumber as string);
  assert.equal(new Set(invoices).size, 3);
  for (const invoice of invoices) assert.match(invoice, /^HB-\d{4}$/);
  assert.equal(
    await db.saleUnit.count({
      where: { batteryUnitId: units[1].id, releasedAt: null },
    }),
    1,
  );
});

test("deleting sales and unused purchases reverses exact stock and payments once and preserves history", async () => {
  const suffix = randomUUID();
  const types = await db.productType.findMany({
    where: { code: { in: ["PARTS", "BATTERY"] } },
  });
  const cash = await db.account.findUniqueOrThrow({ where: { code: "1100" } });
  const write = async (path: string, body: object, key = randomUUID()) =>
    owner
      .post("/api/v1/" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .set("Idempotency-Key", key)
      .send(body);
  const customer = await db.customer.create({
    data: {
      name: "Cancellation customer " + suffix,
      phone: "01710000000",
      address: "Dhaka",
    },
  });
  const parts = (
    await write("products", {
      typeId: types.find((t) => t.code === "PARTS")!.id,
      name: "Cancellation parts " + suffix,
      unit: "pcs",
      category: "Cancellation fittings " + suffix,
    })
  ).body.data;
  const battery = (
    await write("products", {
      typeId: types.find((t) => t.code === "BATTERY")!.id,
      name: "Cancellation battery " + suffix,
      unit: "pcs",
      model: "Cancellation battery model",
      warrantyMonths: 12,
    })
  ).body.data;
  const suppliers = await Promise.all(
    types.map((type) =>
      db.supplier.create({
        data: {
          name: "Cancellation supplier " + type.code + suffix,
          productTypeId: type.id,
        },
      }),
    ),
  );
  const purchaseBodies = [
    {
      supplierId: suppliers.find((s) => s.productTypeId === parts.type.id)!.id,
      purchaseDate: "2025-01-01",
      reference: "Reversal parts receipt",
      items: [{ productId: parts.id, quantity: 5, unitPrice: "10.00" }],
      paidAmount: "20.00",
      paymentAccountId: cash.id,
    },
    {
      supplierId: suppliers.find((s) => s.productTypeId === battery.type.id)!
        .id,
      purchaseDate: "2025-01-01",
      reference: "Reversal battery receipt",
      items: [{ productId: battery.id, quantity: 2, unitPrice: "100.00" }],
      paidAmount: "50.00",
      paymentAccountId: cash.id,
    },
  ];
  const purchaseKeys = [randomUUID(), randomUUID()];
  const purchases: { id: string; number: string }[] = [];
  for (let index = 0; index < purchaseBodies.length; index++) {
    const response = await write(
      "purchases/receive",
      purchaseBodies[index],
      purchaseKeys[index],
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    purchases.push(response.body.data);
  }
  assert.match(purchases[0].number, /^PUR-\d{6}$/);
  assert.equal(
    Number(purchases[1].number.slice(4)),
    Number(purchases[0].number.slice(4)) + 1,
  );
  const saleBody = {
    customerId: customer.id,
    saleDate: "2025-01-31",
    items: [
      { productId: parts.id, quantity: 2, unitPrice: "20.00" },
      { productId: battery.id, quantity: 1, unitPrice: "150.00" },
    ],
    paidAmount: "100.00",
    paymentAccountId: cash.id,
  };
  const saleKey = randomUUID();
  const summaryService = new DashboardService(db);
  const baselineSummary = (await summaryService.get(true)).financials!;
  const baselineInvoiceDay = (
    await summaryService.get(true, "2025-01-31", "2025-01-31")
  ).financials!;
  const created = await write("sales/complete", saleBody, saleKey);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saleId = created.body.data.id;
  const remove = async (
    path: string,
    body: object = {
      confirmed: true,
      reason: "Entry entered by mistake; goods and money returned",
    },
    agent = owner,
  ) =>
    agent
      .delete("/api/v1/" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  await request(app.getHttpServer())
    .delete("/api/v1/sales/" + saleId)
    .set("Origin", origin())
    .expect(401);
  await owner
    .delete("/api/v1/sales/" + saleId)
    .set("Origin", origin())
    .send({ confirmed: true, reason: "Wrong sale" })
    .expect(403);
  assert.equal((await remove("sales/" + saleId, undefined, staff)).status, 403);
  assert.equal(
    (await remove("purchases/" + purchases[0].id, undefined, staff)).status,
    403,
  );
  for (const invalid of [
    { confirmed: false, reason: "Wrong sale" },
    { confirmed: true, reason: 123 },
    { confirmed: true, reason: "Wrong", total: 0 },
  ])
    assert.equal((await remove("sales/" + saleId, invalid)).status, 400);
  const journalCount = await db.journalEntry.count();
  assert.equal((await remove("purchases/" + purchases[0].id)).status, 409);
  assert.equal(await db.journalEntry.count(), journalCount);
  assert.equal(
    (await db.purchase.findUniqueOrThrow({ where: { id: purchases[0].id } }))
      .status,
    "RECEIVED",
  );
  const soldUnit = await db.saleUnit.findFirstOrThrow({
    where: { saleItem: { saleId } },
  });
  const claim = await db.warrantyClaim.create({
    data: {
      number: "CANCEL-CLAIM-" + suffix,
      complaint: "Test claim",
      eligible: true,
      eligibilityReason: "Within coverage",
      policySnapshot: {},
      receivedDate: new Date("2025-02-01"),
      originalExpiry: soldUnit.coverageExpiry,
      receiptSnapshot: {},
      customerId: customer.id,
      saleUnitId: soldUnit.id,
      faultyUnitId: soldUnit.batteryUnitId,
    },
  });
  assert.equal((await remove("sales/" + saleId)).status, 409);
  assert.equal(await db.journalEntry.count(), journalCount);
  await db.warrantyClaim.delete({ where: { id: claim.id } });
  const cancelled = await Promise.all([
    remove("sales/" + saleId, { confirmed: true }),
    remove("sales/" + saleId, { confirmed: true, reason: "" }),
  ]);
  for (const response of cancelled)
    assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(
    await db.auditLog.count({
      where: { action: "SALE_CANCELLED", resourceId: saleId },
    }),
    1,
  );
  assert.equal((await write("sales/complete", saleBody, saleKey)).status, 409);
  const options = (await owner.get("/api/v1/sales/options").expect(200)).body
    .data;
  assert.equal(
    options.products.find((p: { id: string }) => p.id === parts.id)
      .availableQuantity,
    "5",
  );
  assert.equal(
    options.products.find((p: { id: string }) => p.id === battery.id)
      .availableQuantity,
    "2",
  );
  assert.equal(
    await db.saleUnit.count({
      where: { saleItem: { saleId }, releasedAt: null },
    }),
    0,
  );
  assert.equal(
    await db.sale.count({ where: { id: saleId, status: "CANCELLED" } }),
    1,
  );
  const customerBalance = await db.journalLine.aggregate({
    where: { customerId: customer.id },
    _sum: { debit: true, credit: true },
  });
  assert.equal(
    customerBalance._sum.debit!.sub(customerBalance._sum.credit!).toFixed(2),
    "0.00",
  );
  const salePayment = await db.payment.findFirstOrThrow({
    where: { allocations: { some: { saleId } }, reversedPaymentId: null },
    include: { reversal: true },
  });
  assert.equal(salePayment.reversal?.direction, "OUTGOING");
  assert.equal(salePayment.reversal?.amount.toFixed(2), "100.00");
  for (let index = 0; index < purchases.length; index++) {
    const response = await remove("purchases/" + purchases[index].id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      (await remove("purchases/" + purchases[index].id)).status,
      200,
    );
    assert.equal(
      await db.auditLog.count({
        where: {
          action: "PURCHASE_CANCELLED",
          resourceId: purchases[index].id,
        },
      }),
      1,
    );
    assert.equal(
      (
        await write(
          "purchases/receive",
          purchaseBodies[index],
          purchaseKeys[index],
        )
      ).status,
      409,
    );
  }
  const finalOptions = (await owner.get("/api/v1/sales/options").expect(200))
    .body.data;
  for (const product of [parts, battery])
    assert.equal(
      finalOptions.products.find((p: { id: string }) => p.id === product.id)
        .availableQuantity,
      "0",
    );
  for (const supplier of suppliers) {
    const balance = await db.journalLine.aggregate({
      where: { supplierId: supplier.id },
      _sum: { debit: true, credit: true },
    });
    assert.equal(
      balance._sum.debit!.sub(balance._sum.credit!).toFixed(2),
      "0.00",
    );
  }
  assert.equal(
    await db.batteryUnit.count({
      where: { productId: battery.id, commercialState: "RETIRED" },
    }),
    2,
  );
  const recent = (await owner.get("/api/v1/purchases/recent").expect(200)).body
    .data;
  assert(
    !recent.items.some((item: { id: string }) =>
      purchases.some((p) => p.id === item.id),
    ),
  );
  const saved = (
    await owner
      .get("/api/v1/sales?q=" + created.body.data.invoiceNumber)
      .expect(200)
  ).body.data;
  assert.equal(saved.total, 0);
  const cancelledSummary = (await summaryService.get(true)).financials!;
  assert.equal(cancelledSummary.todaySales, baselineSummary.todaySales);
  assert.equal(cancelledSummary.grossProfit, baselineSummary.grossProfit);
  assert.equal(cancelledSummary.salesIncome, baselineSummary.salesIncome);
  assert.equal(cancelledSummary.salesProfit, baselineSummary.salesProfit);
  // Recycle Bin restores exact batches, original invoice and effective payments.
  const bin = async () =>
    (await owner.get("/api/v1/recycle-bin").expect(200)).body.data as {
      id: string;
      name: string;
      type: string;
    }[];
  const saleEntry = (await bin()).find(
    (e) => e.name === created.body.data.invoiceNumber,
  )!;
  assert(saleEntry);
  await request(app.getHttpServer()).get("/api/v1/recycle-bin").expect(401);
  assert.equal((await staff.get("/api/v1/recycle-bin")).body.data.length, 0);
  const restore = (entryId: string) =>
    write("recycle-bin/" + entryId + "/restore", { confirmed: true });
  const journalBeforeConflict = await db.journalEntry.count();
  assert.equal((await restore(saleEntry.id)).status, 409);
  assert.equal(await db.journalEntry.count(), journalBeforeConflict);
  await owner
    .post("/api/v1/recycle-bin/" + saleEntry.id + "/restore")
    .set("Origin", origin())
    .send({ confirmed: true })
    .expect(403);
  const denied = await staff
    .post("/api/v1/recycle-bin/" + saleEntry.id + "/restore")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(staff))
    .send({ confirmed: true });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await write("recycle-bin/" + saleEntry.id + "/restore", {
        confirmed: false,
      })
    ).status,
    400,
  );
  for (const purchase of purchases) {
    const row = await db.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    const entry = (await bin()).find((e) => e.name === row.number)!;
    assert(entry);
    const restored = await restore(entry.id);
    assert.equal(restored.status, 201, JSON.stringify(restored.body));
    assert.equal((await restore(entry.id)).status, 409);
  }
  const restores = await Promise.all([
    restore(saleEntry.id),
    restore(saleEntry.id),
  ]);
  assert.deepEqual(restores.map((r) => r.status).sort(), [201, 409]);
  const restoredSummary = (await summaryService.get(true)).financials!;
  assert.equal(restoredSummary.todaySales, baselineSummary.todaySales);
  assert.equal(restoredSummary.grossProfit, baselineSummary.grossProfit);
  const invoiceDay = await summaryService.get(true, "2025-01-31", "2025-01-31");
  assert.equal(
    new Prisma.Decimal(invoiceDay.financials!.todaySales)
      .sub(baselineInvoiceDay.todaySales)
      .toFixed(2),
    "190.00",
  );
  assert.equal(
    new Prisma.Decimal(invoiceDay.financials!.grossProfit)
      .sub(baselineInvoiceDay.grossProfit)
      .toFixed(2),
    "70.00",
  );
  assert.equal(
    invoiceDay.salesTrend[0].amount,
    invoiceDay.financials!.todaySales,
  );
  assert.equal(
    new Prisma.Decimal(restoredSummary.salesIncome!)
      .sub(baselineSummary.salesIncome!)
      .toFixed(2),
    "190.00",
  );
  assert.equal(
    new Prisma.Decimal(restoredSummary.salesProfit!)
      .sub(baselineSummary.salesProfit!)
      .toFixed(2),
    "70.00",
  );
  const activeSale = await db.sale.findUniqueOrThrow({ where: { id: saleId } });
  assert.equal(activeSale.invoiceNumber, created.body.data.invoiceNumber);
  assert.equal(activeSale.status, "CONFIRMED");
  const restoredPayment = await db.payment.findMany({
    where: {
      allocations: { some: { saleId } },
      reversedPaymentId: null,
      reversal: { is: null },
    },
  });
  assert.equal(restoredPayment.length, 1);
  assert.equal(restoredPayment[0].amount.toFixed(2), "100.00");
  const restoredOptions = (await owner.get("/api/v1/sales/options").expect(200))
    .body.data;
  assert.equal(
    restoredOptions.products.find((p: { id: string }) => p.id === parts.id)
      .availableQuantity,
    "3",
  );
  assert.equal(
    restoredOptions.products.find((p: { id: string }) => p.id === battery.id)
      .availableQuantity,
    "1",
  );
  const restoredCustomerBalance = await db.journalLine.aggregate({
    where: { customerId: customer.id },
    _sum: { debit: true, credit: true },
  });
  assert.equal(
    restoredCustomerBalance._sum
      .debit!.sub(restoredCustomerBalance._sum.credit!)
      .toFixed(2),
    "90.00",
  );
  assert(!(await bin()).some((e) => e.id === saleEntry.id));
  // A second delete/restore cycle must not reuse journal keys or released units.
  assert.equal((await remove("sales/" + saleId)).status, 200);
  const secondEntry = (await bin()).find(
    (e) => e.name === created.body.data.invoiceNumber,
  )!;
  assert(secondEntry.id !== saleEntry.id);
  assert.equal((await restore(secondEntry.id)).status, 201);
  assert.equal((await remove("sales/" + saleId)).status, 200);
  const finalEntry = (await bin()).find(
    (e) => e.name === created.body.data.invoiceNumber,
  )!;
  assert.equal(
    (await remove("recycle-bin/" + finalEntry.id, { confirmed: true })).status,
    200,
  );
  assert.equal((await restore(finalEntry.id)).status, 409);
  assert(!(await bin()).some((e) => e.id === finalEntry.id));
  assert.equal(
    (await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status,
    "CANCELLED",
  );
  // Purchase restore can also be repeated, then made unavailable permanently.
  for (const purchase of purchases) {
    assert.equal((await remove("purchases/" + purchase.id)).status, 200);
    const row = await db.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    const entry = (await bin()).find((e) => e.name === row.number)!;
    assert.equal((await restore(entry.id)).status, 201);
    assert.equal((await remove("purchases/" + purchase.id)).status, 200);
  }
});

test("supplier recycle bin finalization blocks both restore endpoints and repeated stale actions", async () => {
  const category = await db.productType.findUniqueOrThrow({
    where: { code: "BATTERY" },
  });
  const supplier = await db.supplier.create({
    data: { name: "Bin supplier " + randomUUID(), productTypeId: category.id },
  });
  await owner
    .delete("/api/v1/suppliers/" + supplier.id)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true })
    .expect(200);
  const entry = await db.auditLog.findFirstOrThrow({
    where: { action: "SUPPLIER_DELETED", resourceId: supplier.id },
  });
  await owner
    .delete("/api/v1/recycle-bin/" + entry.id)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true })
    .expect(200);
  for (const path of [
    "/recycle-bin/" + entry.id + "/restore",
    "/suppliers/recycle-bin/" + entry.id + "/restore",
  ])
    await owner
      .post("/api/v1" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send({ confirmed: true })
      .expect(409);
  assert.equal(
    await db.supplier.findUnique({ where: { id: supplier.id } }),
    null,
  );
  for (const path of ["/recycle-bin", "/suppliers/recycle-bin"]) {
    const result = await owner.get("/api/v1" + path).expect(200);
    assert(!result.body.data.some((e: { id: string }) => e.id === entry.id));
  }
  const second = await db.supplier.create({
    data: {
      name: "Restorable supplier " + randomUUID(),
      productTypeId: category.id,
    },
  });
  await owner
    .delete("/api/v1/suppliers/" + second.id)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true })
    .expect(200);
  const secondEntry = await db.auditLog.findFirstOrThrow({
    where: { action: "SUPPLIER_DELETED", resourceId: second.id },
  });
  await owner
    .post("/api/v1/recycle-bin/" + secondEntry.id + "/restore")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true })
    .expect(201);
  assert.equal(
    (await db.supplier.findUniqueOrThrow({ where: { id: second.id } })).name,
    second.name,
  );
  await owner
    .delete("/api/v1/recycle-bin/" + secondEntry.id)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true })
    .expect(409);
});

test("paid expenses persist once, debit the category, credit cash and include transport without double counting", async () => {
  const cash = await db.account.findUniqueOrThrow({ where: { code: "1100" } });
  const invalidAccount = await db.account.findUniqueOrThrow({
    where: { code: "2100" },
  });
  await request(app.getHttpServer()).get("/api/v1/expenses").expect(401);
  await staff.get("/api/v1/expenses").expect(403);
  const options = (await owner.get("/api/v1/expenses/options").expect(200)).body
    .data;
  assert.deepEqual(options.categories, [
    "Office Expense",
    "Transport",
    "Others",
  ]);
  assert.equal(options.cashAvailable, true);
  assert(
    options.paymentAccounts.some(
      (account: { id: string }) => account.id === cash.id,
    ),
  );
  const expenseDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const body = {
    expenseDate,
    category: "Office Expense",
    amount: "25.50",
  };
  const save = async (
    payload: object,
    key: string | undefined = randomUUID(),
    agent = owner,
  ) => {
    const command = agent
      .post("/api/v1/expenses")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent));
    if (key) command.set("Idempotency-Key", key);
    return command.send(payload);
  };
  await owner
    .post("/api/v1/expenses")
    .set("Origin", origin())
    .send(body)
    .expect(403);
  assert.equal((await save(body, randomUUID(), staff)).status, 403);
  const initialExpenses = await db.expense.count(),
    initialJournals = await db.journalEntry.count();
  for (const invalid of [
    { ...body, amount: "0" },
    { ...body, amount: "1.001" },
    { ...body, amount: "-1" },
    { ...body, expenseDate: "2026-02-30" },
    { ...body, description: 0 },
    { ...body, category: "Unknown" },
    { ...body, paymentAccountId: invalidAccount.id },
    { ...body, paymentAccountId: randomUUID() },
  ])
    assert.equal((await save(invalid)).status, 400);
  assert.equal(await db.expense.count(), initialExpenses);
  assert.equal(await db.journalEntry.count(), initialJournals);
  const before = (await owner.get("/api/v1/expenses?pageSize=100").expect(200))
    .body.data;
  const cashBefore = await db.journalLine.aggregate({
    where: { accountId: cash.id },
    _sum: { credit: true },
  });
  const key = randomUUID();
  const concurrent = await Promise.all([save(body, key), save(body, key)]);
  for (const response of concurrent)
    assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(concurrent[0].body, concurrent[1].body);
  assert(
    concurrent.some(
      (response) => response.headers["idempotency-replayed"] === "true",
    ),
  );
  assert.equal(await db.expense.count(), initialExpenses + 1);
  assert.equal(await db.journalEntry.count(), initialJournals + 1);
  assert.equal(
    (await save({ ...body, description: "Changed expense" }, key)).status,
    409,
  );
  const expense = await db.expense.findUniqueOrThrow({
    where: { id: concurrent[0].body.data.id },
    include: { settlements: true, journal: { include: { lines: true } } },
  });
  assert.equal(expense.amount.toFixed(2), "25.50");
  assert.equal(expense.incurredDate.toISOString().slice(0, 10), expenseDate);
  assert.equal(expense.settlements.length, 1);
  assert.equal(expense.settlements[0].journalId, expense.journalId);
  assert.equal(expense.journal.lines.length, 2);
  assert.equal(
    expense.journal.lines
      .find((line) => line.accountId === cash.id)!
      .credit.toFixed(2),
    "25.50",
  );
  const cashAfter = await db.journalLine.aggregate({
    where: { accountId: cash.id },
    _sum: { credit: true },
  });
  assert.equal(
    cashAfter._sum.credit!.sub(cashBefore._sum.credit ?? 0).toFixed(2),
    "25.50",
  );
  const transport = await save({
    ...body,
    category: "Transport",
    description: "Manual transport " + randomUUID(),
    amount: "30.25",
  });
  assert.equal(transport.status, 201, JSON.stringify(transport.body));
  const after = (await owner.get("/api/v1/expenses?pageSize=100").expect(200))
    .body.data;
  assert.equal(
    new Prisma.Decimal(after.summary.total)
      .sub(before.summary.total)
      .toFixed(2),
    "55.75",
  );
  assert.equal(after.total, before.total + 2);
  assert.equal(
    after.items.filter(
      (item: { expenseId: string }) => item.expenseId === expense.id,
    ).length,
    1,
  );
  const priorTransport =
    before.summary.byCategory.find(
      (item: { name: string }) => item.name === "Transport",
    )?.amount ?? "0.00";
  const nextTransport = after.summary.byCategory.find(
    (item: { name: string }) => item.name === "Transport",
  )!.amount;
  assert.equal(
    new Prisma.Decimal(nextTransport).sub(priorTransport).toFixed(2),
    "30.25",
  );
  await owner.get("/api/v1/expenses?pageSize=0").expect(400);
});

test("receiving batteries without serial numbers creates stock and replays safely", async () => {
  for (const [code, kind] of [
    ["1300", "ASSET"],
    ["2100", "LIABILITY"],
    ["5100", "EXPENSE"],
  ] as const) {
    await db.account.upsert({
      where: { code },
      update: {},
      create: { code, name: "Stock valuation " + code, kind },
    });
  }
  const stockValue = async () =>
    Math.round(
      Number(
        (await app.get(DashboardService).get(true, "2000-01-01", "2000-01-01"))
          .financials!.availableStockPurchaseValue,
      ) * 100,
    );
  const initialStockValue = await stockValue();

  const type = await db.productType.upsert({
    where: { code: "BATTERY" },
    update: {},
    create: { code: "BATTERY", name: "Battery", trackingKind: "BATTERY_UNIT" },
  });
  const supplier = await db.supplier.create({
    data: {
      name: "No serial supplier " + id,
      productTypeId: type.id,
    },
  });
  const created = await owner
    .post("/api/v1/products")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({
      typeId: type.id,
      name: "No serial battery " + id,
      model: "Test 200Ah",
      unit: "pcs",
      capacityAh: "200",
    })
    .expect(201);
  const productId = created.body.data.id;
  assert.equal(created.body.data.latestPurchasePrice, null);
  const latestPrice = async (name: string) =>
    (
      await owner
        .get("/api/v1/products?q=" + encodeURIComponent(name))
        .expect(200)
    ).body.data.items.find((item: { id: string }) => item.id === productId)
      ?.latestPurchasePrice;
  const key = randomUUID();
  const body = {
    supplierId: supplier.id,
    purchaseDate: "2026-11-15",
    reference: "Stock receipt " + id,
    items: [{ productId, quantity: 15, unitPrice: "1000.10" }],
  };
  const send = async (payload: object, requestKey = key) =>
    owner
      .post("/api/v1/purchases/receive")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .set("Idempotency-Key", requestKey)
      .send(payload);
  const received = await send(body);
  assert.equal(received.status, 201, JSON.stringify(received.body));
  assert.equal((await stockValue()) - initialStockValue, 1500150);
  assert.equal(await latestPrice(created.body.data.name), "1000.10");
  const replay = await send(body);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.body.data.receiptId, received.body.data.receiptId);
  const units = await db.batteryUnit.findMany({ where: { productId } });
  assert.equal(units.length, 15);
  assert.equal(new Set(units.map((unit) => unit.internalCode)).size, 15);
  assert(
    units.every(
      (unit) =>
        unit.serialNumber === null &&
        unit.normalizedSerial === null &&
        unit.productionDate === null &&
        unit.commercialState === "AVAILABLE",
    ),
  );
  assert.equal(await db.stockMovement.count({ where: { productId } }), 15);
  const tooMany = await send(
    { ...body, items: [{ productId, quantity: 501, unitPrice: "0.00" }] },
    randomUUID(),
  );
  assert.equal(tooMany.status, 400);
  assert.equal(await db.batteryUnit.count({ where: { productId } }), 15);
  const customer = await db.customer.create({
    data: { name: "No serial customer " + id, phone: "01712345678" },
  });
  const sale = await owner
    .post("/api/v1/sales/complete")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .set("Idempotency-Key", randomUUID())
    .send({
      customerId: customer.id,
      saleDate: "2026-11-15",
      items: [{ productId, quantity: 3, unitPrice: "1.00" }],
    });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(
    await db.batteryUnit.count({
      where: { productId, commercialState: "AVAILABLE" },
    }),
    12,
  );
  assert.equal(
    await db.batteryUnit.count({
      where: { productId, commercialState: "SOLD" },
    }),
    3,
  );
  assert.equal((await stockValue()) - initialStockValue, 1200120);
  const extraBatch = await send(
    { ...body, items: [{ productId, quantity: 2, unitPrice: "2000.25" }] },
    randomUUID(),
  );
  assert.equal(extraBatch.status, 201, JSON.stringify(extraBatch.body));
  assert.equal(await latestPrice(created.body.data.name), "2000.25");
  assert.equal((await stockValue()) - initialStockValue, 1600170);
  const partType = await db.productType.findUniqueOrThrow({
    where: { code: "PARTS" },
  });
  const partSupplier = await db.supplier.create({
    data: {
      name: "Valuation parts supplier " + id,
      productTypeId: partType.id,
    },
  });
  const partProduct = await owner
    .post("/api/v1/products")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({
      typeId: partType.id,
      name: "Valuation part " + id,
      category: "Valuation part " + id,
      unit: "pcs",
    })
    .expect(201);
  const partsReceived = await send(
    {
      supplierId: partSupplier.id,
      purchaseDate: body.purchaseDate,
      reference: "Valuation parts receipt " + id,
      items: [
        {
          productId: partProduct.body.data.id,
          quantity: 7,
          unitPrice: "12.34",
        },
      ],
    },
    randomUUID(),
  );
  assert.equal(partsReceived.status, 201, JSON.stringify(partsReceived.body));
  assert.equal((await stockValue()) - initialStockValue, 1608808);
  const options = await owner.get("/api/v1/sales/options").expect(200);
  const available = options.body.data.products.find(
    (item: { id: string }) => item.id === productId,
  );
  assert.equal(available.availableQuantity, "14");
  assert.equal(Object.hasOwn(available, "units"), false);
  const forbidden = await send(
    {
      ...body,
      items: [
        { ...body.items[0], identities: [{ serialNumber: "SHOULD-NOT-SAVE" }] },
      ],
    },
    randomUUID(),
  );
  assert.equal(forbidden.status, 400);
});

test("replacement status dropdown persists four stages with validation, permissions and conflict protection", async () => {
  const sourceUnit = await db.batteryUnit.findFirstOrThrow({
    where: { origin: "OPENING" },
  });
  const supplier = await db.supplier.create({
    data: { name: "Status test supplier " + id },
  });
  const unit = await db.batteryUnit.create({
    data: {
      productId: sourceUnit.productId,
      batchId: sourceUnit.batchId,
      origin: "OPENING",
      internalCode: "status-unit-" + id,
      condition: "FAULTY",
    },
  });
  const record = await db.replacementRecord.create({
    data: {
      number: "status-case-" + id,
      source: "BEFORE_SALE",
      faultReason: "Status test",
      oldUnitId: unit.id,
      supplierId: supplier.id,
    },
  });
  const list = async (status = "all") =>
    (
      await owner
        .get("/api/v1/replacements")
        .query({ q: record.number, status })
        .expect(200)
    ).body.data as ReplacementList;
  let rows = await list();
  assert.equal(rows.total, 1);
  assert.equal(rows.items[0].status, "FAULTY");
  assert.equal(rows.items[0].serial, unit.internalCode);
  const send = async (status: string, version: number, agent = owner) =>
    agent
      .post(`/api/v1/replacements/${record.id}/status`)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send({ status, version });
  assert.equal((await send("SENT", 1, staff)).status, 403);
  assert.equal((await send("UNKNOWN", 1)).status, 400);
  let version = 1;
  for (const [stage, stored] of [
    ["SENT", "SENT_TO_COMPANY"],
    ["RECEIVED", "REPLACEMENT_RECEIVED"],
    ["DELIVERED", "COMPLETED"],
  ]) {
    const response = await send(stage, version);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.version, ++version);
    const saved = await db.replacementRecord.findUniqueOrThrow({
      where: { id: record.id },
    });
    assert.equal(saved.status, stored);
    rows = await list(stage);
    assert.equal(rows.total, 1);
    assert.equal(rows.items[0].status, stage);
    assert(rows.summary[stage as keyof ReplacementList["summary"]] >= 1);
  }
  assert.equal((await list("FAULTY")).total, 0);
  assert.equal((await send("FAULTY", 1)).status, 409);
  const logs = await db.auditLog.findMany({
    where: { resourceId: record.id, action: "REPLACEMENT_STATUS_CHANGED" },
  });
  assert.equal(logs.length, 3);
  assert(logs.every((log) => log.actorId === ownerId));
  await db.replacementRecord.update({
    where: { id: record.id },
    data: { status: "UNDER_REVIEW" },
  });
  assert.equal((await list("SENT")).items[0].status, "SENT");
  await db.replacementRecord.update({
    where: { id: record.id },
    data: { status: "READY_FOR_CUSTOMER_DELIVERY" },
  });
  assert.equal((await list("RECEIVED")).items[0].status, "RECEIVED");
});

test("replacement intake loads real stock and invoice batteries and registers each source atomically", async () => {
  const template = await db.batteryUnit.findFirstOrThrow({
    where: { origin: "OPENING" },
  });
  const supplier = await db.supplier.create({
    data: { name: "Intake supplier " + id },
  });
  const stock = await db.batteryUnit.create({
    data: {
      productId: template.productId,
      batchId: template.batchId,
      origin: "OPENING",
      internalCode: "intake-unit-" + id,
      condition: "GOOD",
      commercialState: "AVAILABLE",
    },
  });
  const stockOptions = await owner
    .get("/api/v1/replacements/options")
    .query({ source: "BEFORE_SALE", q: stock.internalCode })
    .expect(200);
  await db.batteryUnit.create({
    data: {
      productId: stock.productId,
      batchId: stock.batchId,
      origin: "OPENING",
      internalCode: "intake-extra-" + id,
      condition: "GOOD",
      commercialState: "AVAILABLE",
    },
  });
  assert.equal(stockOptions.body.data.units[0].id, stock.id);
  assert(
    stockOptions.body.data.suppliers.some(
      (item: { id: string }) => item.id === supplier.id,
    ),
  );
  const intake = async (body: object, agent = owner) =>
    agent
      .post("/api/v1/replacements")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  const stockBody = {
    id: randomUUID(),
    source: "BEFORE_SALE",
    unitId: stock.id,
    supplierId: supplier.id,
    faultReason: "Not charging",
    quantity: 2,
  };
  assert.equal((await intake(stockBody, staff)).status, 403);
  const registered = await intake(stockBody);
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.equal(registered.body.data.quantity, 2);
  assert.equal(
    await db.auditLog.count({
      where: {
        action: "REPLACEMENT_CREATED",
        metadata: { path: ["registrationId"], equals: stockBody.id },
      },
    }),
    2,
  );
  assert.equal((await intake(stockBody)).body.data.id, stockBody.id);
  assert.equal((await intake({ ...stockBody, quantity: 1 })).status, 409);
  assert.equal(
    await db.replacementRecord.count({ where: { oldUnitId: stock.id } }),
    1,
  );
  assert.equal(
    await db.stockMovement.count({
      where: {
        batteryUnitId: stock.id,
        reason: { startsWith: "Replacement intake" },
      },
    }),
    1,
  );
  const faulty = await db.batteryUnit.findUniqueOrThrow({
    where: { id: stock.id },
  });
  assert.equal(faulty.condition, "FAULTY");
  assert.equal(faulty.commercialState, "UNAVAILABLE");
  const after = await owner
    .get("/api/v1/replacements/options")
    .query({ source: "BEFORE_SALE", q: stock.internalCode })
    .expect(200);
  assert.equal(after.body.data.units.length, 0);
  const sold = await db.saleUnit.findFirstOrThrow({
    where: {
      releasedAt: null,
      batteryUnit: { ownership: "CUSTOMER", custody: "CUSTOMER" },
      saleItem: {
        sale: { status: { in: ["CONFIRMED", "PARTIALLY_RETURNED"] } },
      },
    },
    include: { batteryUnit: true, saleItem: { include: { sale: true } } },
  });
  const warrantyOptions = await owner
    .get("/api/v1/replacements/options")
    .query({ source: "CUSTOMER_WARRANTY", q: sold.saleItem.sale.invoiceNumber })
    .expect(200);
  const choices = warrantyOptions.body.data.units as {
    id: string;
    productId: string;
    saleUnitId: string;
    label: string;
  }[];
  const choice = choices.find(
    (item) => item.productId === sold.batteryUnit.productId,
  );
  assert(choice);
  assert(!choice.label.includes("BAT-"));
  assert(!choice.label.includes(sold.saleItem.sale.invoiceNumber!));
  const representedSales = await db.saleUnit.findMany({
    where: { id: { in: choices.map((item) => item.saleUnitId) } },
  });
  assert.equal(
    new Set(representedSales.map((item) => item.saleItemId)).size,
    choices.length,
  );
  const warrantyBody = {
    id: randomUUID(),
    source: "CUSTOMER_WARRANTY",
    unitId: choice.id,
    saleUnitId: choice.saleUnitId,
    supplierId: supplier.id,
    faultReason: "Warranty fault",
  };
  const warranty = await intake(warrantyBody);
  assert.equal(warranty.status, 201, JSON.stringify(warranty.body));
  const record = await db.replacementRecord.findUniqueOrThrow({
    where: { id: warrantyBody.id },
    include: { warrantyClaim: true, oldUnit: true },
  });
  assert.equal(record.reservedCustomerId, sold.saleItem.sale.customerId);
  assert.equal(record.warrantyClaim?.saleUnitId, choice.saleUnitId);
  assert.equal(record.status, "PENDING_RETURN");
  assert.equal(record.oldUnit.custody, "SHOP");
  assert.equal(record.oldUnit.ownership, "CUSTOMER");
  assert.equal(
    (await intake({ ...warrantyBody, id: randomUUID() })).status,
    409,
  );
  const list = await owner
    .get("/api/v1/replacements")
    .query({ q: sold.saleItem.sale.invoiceNumber })
    .expect(200);
  assert(
    list.body.data.items.some(
      (item: { id: string }) => item.id === warrantyBody.id,
    ),
  );
  await owner
    .delete(`/api/v1/replacements/${warrantyBody.id}`)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ confirmed: true, version: 1 })
    .expect(200);
  const restoredCustomerUnit = await db.batteryUnit.findUniqueOrThrow({
    where: { id: choice.id },
  });
  assert.equal(restoredCustomerUnit.custody, "CUSTOMER");
  assert.equal(restoredCustomerUnit.ownership, "CUSTOMER");
  assert.equal(restoredCustomerUnit.commercialState, "SOLD");
});

test("replacement quantity stays within the selected invoice, rejects shortages atomically and replays once", async () => {
  const template = await db.batteryUnit.findFirstOrThrow({
    where: { origin: "OPENING" },
  });
  const customer = await db.customer.findFirstOrThrow();
  const supplier = await db.supplier.create({
    data: { name: "Quantity supplier " + id },
  });
  const units = await Promise.all(
    [0, 1, 2].map((index) =>
      db.batteryUnit.create({
        data: {
          productId: template.productId,
          batchId: template.batchId,
          origin: "OPENING",
          internalCode: `quantity-unit-${id}-${index}`,
          condition: "GOOD",
          custody: "CUSTOMER",
          ownership: "CUSTOMER",
          commercialState: "SOLD",
        },
      }),
    ),
  );
  const sale = await db.sale.create({
    data: {
      invoiceNumber: "quantity-invoice-" + id,
      customer: { connect: { id: customer.id } },
      status: "CONFIRMED",
      soldAt: new Date(),
      posting: {
        create: {
          kind: "TEST",
          sourceCode: "quantity-sale-" + id,
          actorId: ownerId,
        },
      },
      items: {
        create: {
          lineNumber: 1,
          productId: template.productId,
          productSnapshot: {},
          quantity: 3,
          units: {
            create: units.map((unit) => ({
              batteryUnitId: unit.id,
              coverageStart: new Date("2026-01-01"),
              coverageExpiry: new Date("2027-12-31"),
            })),
          },
        },
      },
    },
    include: { items: { include: { units: true } } },
  });
  const body = {
    id: randomUUID(),
    source: "CUSTOMER_WARRANTY",
    unitId: units[0].id,
    saleUnitId: sale.items[0].units.find(
      (item) => item.batteryUnitId === units[0].id,
    )!.id,
    supplierId: supplier.id,
    faultReason: "Multiple faulty batteries",
    quantity: 2,
  };
  const send = async (payload: object) =>
    owner
      .post("/api/v1/replacements")
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(owner))
      .send(payload);
  for (const quantity of [0, 1.5, 101])
    assert.equal((await send({ ...body, quantity })).status, 400);
  assert.equal((await send({ ...body, quantity: 4 })).status, 409);
  assert.equal(
    await db.replacementRecord.count({
      where: { oldUnitId: { in: units.map((unit) => unit.id) } },
    }),
    0,
  );
  const registered = await send(body);
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.equal(registered.body.data.quantity, 2);
  assert.deepEqual((await send(body)).body, registered.body);
  const records = await db.replacementRecord.findMany({
    where: { oldUnitId: { in: units.map((unit) => unit.id) } },
    include: {
      warrantyClaim: { include: { saleUnit: { include: { saleItem: true } } } },
    },
  });
  assert.equal(records.length, 2);
  assert(
    records.every(
      (record) => record.warrantyClaim?.saleUnit.saleItem.saleId === sale.id,
    ),
  );
  assert.equal(new Set(records.map((record) => record.oldUnitId)).size, 2);
  assert.equal(
    await db.auditLog.count({
      where: {
        action: "REPLACEMENT_CREATED",
        metadata: { path: ["registrationId"], equals: body.id },
      },
    }),
    2,
  );
});

test("customer sales history returns only that customer's posted invoices and original product snapshots", async () => {
  const sale = await db.sale.findFirstOrThrow({
    where: { status: "CONFIRMED", items: { some: {} } },
    include: { items: { include: { product: true } } },
  });
  const url = `/api/v1/customers/${sale.customerId}/sales`;
  await request(app.getHttpServer()).get(url).expect(401);
  await owner.get(`/api/v1/customers/${randomUUID()}/sales`).expect(404);
  await owner.get("/api/v1/customers/not-a-uuid/sales").expect(400);
  await owner.get(url).query({ page: 0 }).expect(400);
  const response = await owner.get(url).query({ pageSize: 50 }).expect(200);
  const posted = await db.sale.findMany({
    where: {
      customerId: sale.customerId,
      status: { in: ["CONFIRMED", "PARTIALLY_RETURNED", "RETURNED"] },
    },
    orderBy: [{ soldAt: "desc" }, { id: "desc" }],
  });
  assert.equal(response.body.data.customer.id, sale.customerId);
  assert.equal(response.body.data.total, posted.length);
  assert.deepEqual(
    response.body.data.items.map((item: { id: string }) => item.id),
    posted.map((item) => item.id),
  );
  const returned = response.body.data.items.find(
    (item: { id: string }) => item.id === sale.id,
  );
  assert(returned);
  assert.equal(returned.soldAt, sale.soldAt?.toISOString() ?? null);
  assert.equal(returned.total, sale.total.toFixed(2));
  const selectedSale = await owner
    .get(url)
    .query({ saleId: sale.id })
    .expect(200);
  assert.equal(selectedSale.body.data.total, 1);
  assert.deepEqual(
    selectedSale.body.data.items.map((item: { id: string }) => item.id),
    [sale.id],
  );
  await owner.get(url).query({ saleId: "invalid" }).expect(400);
  const missingSale = await owner
    .get(url)
    .query({ saleId: randomUUID() })
    .expect(200);
  assert.equal(missingSale.body.data.items.length, 0);
  for (const item of sale.items) {
    const product = returned.products.find(
      (row: { id: string }) => row.id === item.id,
    );
    assert(product);
    const snapshot = item.productSnapshot as Prisma.JsonObject;
    assert.equal(
      product.name,
      typeof snapshot.name === "string" ? snapshot.name : item.product.name,
    );
    assert.equal(
      product.model,
      typeof snapshot.model === "string" ? snapshot.model : item.product.model,
    );
    assert.equal(product.quantity, item.quantity.toString());
    assert.equal(product.unitPrice, item.unitPrice.toFixed(2));
    assert.equal(Object.hasOwn(product, "costTotal"), false);
  }
  const paginated = await owner
    .get(url)
    .query({ page: 1, pageSize: 1 })
    .expect(200);
  assert.equal(paginated.body.data.items.length, 1);
  assert.equal(paginated.body.data.total, posted.length);
  const empty = await db.customer.create({
    data: { name: "No-history customer " + id, phone: "01700000000" },
  });
  const emptyHistory = await owner
    .get(`/api/v1/customers/${empty.id}/sales`)
    .expect(200);
  assert.equal(emptyHistory.body.data.total, 0);
  assert.deepEqual(emptyHistory.body.data.items, []);
});

test("customer ledger carries opening balances, returns and collections with atomic payment replay", async () => {
  const customer = await db.customer.create({
    data: {
      name: "Ledger customer " + id,
      phone: "01700000000",
      address: "Dhaka",
    },
  });
  const [receivable, revenue, cash] = await Promise.all(
    ["1200", "4100", "1100"].map((code) =>
      db.account.findUniqueOrThrow({ where: { code } }),
    ),
  );
  const createInvoice = async (total: string, date: string) =>
    db.$transaction(async (tx) => {
      const posting = await tx.posting.create({
        data: {
          actorId: ownerId,
          kind: "SALE_COMPLETE",
          sourceCode: "ledger-test:" + randomUUID(),
        },
      });
      const soldAt = new Date(date + "T12:00:00+06:00");
      const sale = await tx.sale.create({
        data: {
          customerId: customer.id,
          postingId: posting.id,
          invoiceNumber: "LEDGER-" + randomUUID(),
          status: "CONFIRMED",
          soldAt,
          subtotal: total,
          total,
        },
      });
      await tx.journalEntry.create({
        data: {
          postingId: posting.id,
          postedAt: soldAt,
          reason: "Ledger test invoice",
          lines: {
            create: [
              {
                customerId: customer.id,
                accountId: receivable.id,
                debit: total,
              },
              { accountId: revenue.id, credit: total },
            ],
          },
        },
      });
      return sale;
    });
  const first = await createInvoice("100.50", "2026-11-10");
  const second = await createInvoice("200.25", "2026-11-12");
  const url = `/api/v1/customers/${customer.id}/ledger`;
  await request(app.getHttpServer()).get(url).expect(401);
  await owner.get(url).query({ from: "2026-11-10" }).expect(400);
  await owner
    .get(url)
    .query({ from: "2026-02-30", to: "2026-11-12" })
    .expect(400);
  const initial = (await owner.get(url).expect(200)).body.data;
  assert.equal(initial.summary.closing, "300.75");
  const paymentUrl = `/api/v1/customers/${customer.id}/payments`;
  const body = {
    date: "2026-11-11",
    amount: "50.25",
    paymentAccountId: cash.id,
    reference: "Ledger receipt",
  };
  const token = await csrf(owner);
  const key = randomUUID();
  const collect = (payload: object, requestKey = key) =>
    owner
      .post(paymentUrl)
      .set("Origin", origin())
      .set("X-CSRF-Token", token)
      .set("Idempotency-Key", requestKey)
      .send(payload);
  await owner
    .post(paymentUrl)
    .set("Origin", origin())
    .set("Idempotency-Key", key)
    .send(body)
    .expect(403);
  await collect({ ...body, amount: "300.76" }, randomUUID()).expect(400);
  const receipt = (await collect(body).expect(201)).body.data;
  assert.equal(receipt.due, "250.50");
  assert.deepEqual((await collect(body).expect(201)).body.data, receipt);
  await collect({ ...body, amount: "51.25" }).expect(409);
  assert.equal(await db.payment.count({ where: { id: receipt.id } }), 1);
  assert.equal(
    (
      await db.paymentAllocation.findFirstOrThrow({
        where: { paymentId: receipt.id },
      })
    ).saleId,
    first.id,
  );
  const period = (
    await owner
      .get(url)
      .query({ from: "2026-11-12", to: "2026-11-12" })
      .expect(200)
  ).body.data;
  assert.deepEqual(period.summary, {
    opening: "50.25",
    debit: "200.25",
    credit: "0.00",
    closing: "250.50",
  });
  assert.equal(period.items.length, 1);
  assert.equal(period.items[0].balance, "250.50");
  await db.$transaction(async (tx) => {
    const posting = await tx.posting.create({
      data: {
        actorId: ownerId,
        kind: "SALES_RETURN",
        sourceCode: "ledger-return:" + randomUUID(),
      },
    });
    await tx.salesReturn.create({
      data: {
        number: "RETURN-" + randomUUID(),
        saleId: second.id,
        postingId: posting.id,
        reason: "Ledger return",
        creditAmount: "20.00",
      },
    });
    await tx.sale.update({
      where: { id: second.id },
      data: { status: "PARTIALLY_RETURNED" },
    });
    await tx.journalEntry.create({
      data: {
        postingId: posting.id,
        postedAt: new Date("2026-11-13T12:00:00+06:00"),
        reason: "Ledger return",
        lines: {
          create: [
            { accountId: revenue.id, debit: "20.00" },
            {
              accountId: receivable.id,
              customerId: customer.id,
              credit: "20.00",
            },
          ],
        },
      },
    });
  });
  const returned = (await owner.get(url).expect(200)).body.data;
  assert.equal(returned.summary.closing, "230.50");
  assert(
    returned.items.some((entry: { kind: string }) => entry.kind === "return"),
  );
  const attempts = await Promise.all([
    collect({ ...body, date: "2026-11-14", amount: "160.00" }, randomUUID()),
    collect({ ...body, date: "2026-11-14", amount: "160.00" }, randomUUID()),
  ]);
  assert.deepEqual(
    attempts.map((response) => response.status).sort(),
    [201, 400],
  );
  const final = (await owner.get(url).expect(200)).body.data;
  assert.equal(final.summary.closing, "70.50");
  assert.equal(final.customer.due, "70.50");
  assert.equal(final.items.at(-1).balance, "70.50");
  assert.equal(
    await db.auditLog.count({
      where: {
        action: "CUSTOMER_DUE_COLLECTION",
        metadata: { path: ["customerId"], equals: customer.id },
      },
    }),
    2,
  );
});

test("customer ledger combines an invoice and its initial payment in one simple row", async () => {
  const customer = await db.customer.create({
    data: { name: "Ledger ordering " + id, phone: "01700000001" },
  });
  const [receivable, revenue, cash] = await Promise.all(
    ["1200", "4100", "1100"].map((code) =>
      db.account.findUniqueOrThrow({ where: { code } }),
    ),
  );
  await db.$transaction(async (tx) => {
    const date = new Date("2026-11-15T06:00:00Z");
    const posting = await tx.posting.create({
      data: {
        actorId: ownerId,
        kind: "SALE_COMPLETE",
        sourceCode: "ledger-order:" + randomUUID(),
      },
    });
    const sale = await tx.sale.create({
      data: {
        customerId: customer.id,
        postingId: posting.id,
        status: "CONFIRMED",
        soldAt: date,
        subtotal: "100",
        total: "100",
      },
    });
    const saleJournal = await tx.journalEntry.create({
      data: {
        id: "ffffffff" + randomUUID().slice(8),
        postingId: posting.id,
        postedAt: date,
        lines: {
          create: [
            { accountId: receivable.id, customerId: customer.id, debit: "100" },
            { accountId: revenue.id, credit: "100" },
          ],
        },
      },
    });
    const paymentPosting = await tx.posting.create({
      data: {
        actorId: ownerId,
        kind: "CUSTOMER_PAYMENT",
        sourceCode: "ledger-order-payment:" + randomUUID(),
      },
    });
    const journal = await tx.journalEntry.create({
      data: {
        id: "00000000" + randomUUID().slice(8),
        postingId: paymentPosting.id,
        postedAt: date,
        createdAt: saleJournal.createdAt,
        lines: {
          create: [
            { accountId: cash.id, debit: "40" },
            { accountId: receivable.id, customerId: customer.id, credit: "40" },
          ],
        },
      },
    });
    await tx.payment.create({
      data: {
        number: "ORDER-PAY-" + randomUUID(),
        amount: "40",
        method: "CASH",
        direction: "INCOMING",
        occurredAt: date,
        customerId: customer.id,
        assetAccountId: cash.id,
        journalId: journal.id,
        allocations: { create: { saleId: sale.id, amount: "40" } },
      },
    });
  });
  const ledger = (
    await owner.get(`/api/v1/customers/${customer.id}/ledger`).expect(200)
  ).body.data;
  assert.deepEqual(
    ledger.items.map((item: { kind: string; balance: string }) => [
      item.kind,
      item.balance,
    ]),
    [["sale", "60.00"]],
  );
  assert.equal(ledger.items[0].debit, "100.00");
  assert.equal(ledger.items[0].credit, "40.00");
  const role = await db.role.create({
    data: {
      code: "LEDGER_READER_" + id,
      name: "Ledger reader",
      permissions: {
        create: { permission: { connect: { code: "parties.customers" } } },
      },
    },
  });
  const readerLogin = "ledger-reader-" + id;
  await db.user.create({
    data: {
      name: "Ledger reader",
      login: readerLogin,
      passwordHash: await hash(password, passwordOptions),
      roles: { create: { roleId: role.id } },
    },
  });
  const reader = request.agent(app.getHttpServer());
  assert.equal((await login(reader, readerLogin)).status, 201);
  assert.deepEqual(
    (await reader.get(`/api/v1/customers/${customer.id}/ledger`).expect(200))
      .body.data.paymentAccounts,
    [],
  );
  await reader
    .post(`/api/v1/customers/${customer.id}/payments`)
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(reader))
    .set("Idempotency-Key", randomUUID())
    .send({ date: "2026-11-16", amount: "1", paymentAccountId: cash.id })
    .expect(403);
});

test("simple customer statements omit cancelled invoice activity and still reconcile with the account", async () => {
  const customer = await db.customer.findFirstOrThrow({
    where: { sales: { some: { status: "CANCELLED" } } },
  });
  const active = await db.sale.findMany({
    where: {
      customerId: customer.id,
      status: { in: ["CONFIRMED", "PARTIALLY_RETURNED", "RETURNED"] },
    },
    select: { id: true },
  });
  const ledger = (
    await owner.get(`/api/v1/customers/${customer.id}/ledger`).expect(200)
  ).body.data;
  assert.equal(ledger.summary.closing, ledger.customer.due);
  assert.deepEqual(
    ledger.items
      .filter((item: { kind: string }) => item.kind === "sale")
      .map((item: { id: string }) => item.id)
      .sort(),
    active.map((sale) => sale.id).sort(),
  );
  assert(
    !ledger.items.some(
      (item: { kind: string; reference: string }) =>
        item.kind === "reversal" || /^(PAY|REV|RST)-/.test(item.reference),
    ),
  );
});

test("replacement deletion restores stock once, excludes cancelled cases and rejects later movements", async () => {
  const template = await db.batteryUnit.findFirstOrThrow({
    where: { origin: "OPENING" },
  });
  const supplier = await db.supplier.create({
    data: { name: "Delete replacement " + id },
  });
  const unit = await db.batteryUnit.create({
    data: {
      productId: template.productId,
      batchId: template.batchId,
      origin: "OPENING",
      internalCode: "delete-replacement-" + id,
      condition: "GOOD",
      commercialState: "AVAILABLE",
    },
  });
  const registration = {
    id: randomUUID(),
    source: "BEFORE_SALE",
    unitId: unit.id,
    supplierId: supplier.id,
  };
  await owner
    .post("/api/v1/replacements")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send(registration)
    .expect(201);
  const remove = async (
    agent = owner,
    body = { confirmed: true, version: 1 },
  ) =>
    agent
      .delete("/api/v1/replacements/" + registration.id)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  assert.equal((await remove(staff)).status, 403);
  assert.equal(
    (await remove(owner, { confirmed: false, version: 1 })).status,
    400,
  );
  assert.equal(
    (await remove(owner, { confirmed: true, version: 2 })).status,
    409,
  );
  const intake = await db.stockMovement.findFirstOrThrow({
    where: {
      batteryUnitId: unit.id,
      posting: { sourceCode: "replacement-intake:" + registration.id },
    },
  });
  const results = await Promise.all([remove(), remove()]);
  assert.deepEqual(
    results.map((response) => response.status),
    [200, 200],
  );
  const restored = await db.batteryUnit.findUniqueOrThrow({
    where: { id: unit.id },
  });
  assert.equal(restored.condition, "GOOD");
  assert.equal(restored.custody, "SHOP");
  assert.equal(restored.ownership, "SHOP");
  assert.equal(restored.commercialState, "AVAILABLE");
  assert.equal(
    await db.stockMovement.count({ where: { reversedMovementId: intake.id } }),
    1,
  );
  assert.equal(
    await db.auditLog.count({
      where: { action: "REPLACEMENT_DELETED", resourceId: registration.id },
    }),
    1,
  );
  const list = await owner
    .get("/api/v1/replacements")
    .query({ q: unit.internalCode })
    .expect(200);
  assert(
    !list.body.data.items.some(
      (item: { id: string }) => item.id === registration.id,
    ),
  );
  await owner
    .post("/api/v1/replacements/" + registration.id + "/status")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ status: "FAULTY", version: 2 })
    .expect(409);
  const options = await owner
    .get("/api/v1/replacements/options")
    .query({ source: "BEFORE_SALE", q: unit.internalCode })
    .expect(200);
  assert(
    options.body.data.units.some((item: { id: string }) => item.id === unit.id),
  );
  await owner
    .post("/api/v1/replacements")
    .set("Origin", origin())
    .set("X-CSRF-Token", await csrf(owner))
    .send({ ...registration, id: (registration.id = randomUUID()) })
    .expect(201);
  const posting = await db.posting.create({
    data: {
      kind: "TEST",
      sourceCode: "after-replacement-" + id,
      actorId: ownerId,
    },
  });
  await db.stockMovement.create({
    data: {
      postingId: posting.id,
      lineNumber: 1,
      productId: unit.productId,
      batchId: unit.batchId,
      batteryUnitId: unit.id,
      quantity: 1,
      reason: "Later movement test",
    },
  });
  assert.equal((await remove()).status, 409);
});

test("inventory product editing checks permissions, versions and duplicates without changing stock", async () => {
  const type = await db.productType.upsert({
    where: { code: "PARTS" },
    update: { active: true },
    create: { code: "PARTS", name: "Parts", trackingKind: "QUANTITY" },
  });
  const post = async (agent: TestAgent, path: string, body: object) =>
    agent
      .post("/api/v1/" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  const name = "Edit fixture " + id;
  await post(owner, "categories", { typeId: type.id, name });
  const created = await post(owner, "products", {
    typeId: type.id,
    name,
    category: name,
    model: "OLD",
    unit: "pcs",
    defaultSellingPrice: "100.00",
    warrantyMonths: 6,
  });
  assert.equal(created.status, 201);
  const productId = created.body.data.id;
  const posting = await db.posting.create({
    data: {
      actorId: ownerId,
      kind: "TEST_OPENING",
      sourceCode: "edit-opening-" + id,
    },
  });
  const opening = await db.openingBalance.create({
    data: {
      number: "edit-opening-" + id,
      postingId: posting.id,
      reason: "Isolated edit test",
      reconciliationReference: id,
    },
  });
  const openingItem = await db.openingBalanceItem.create({
    data: {
      openingId: opening.id,
      deduplicationKey: "edit-item-" + id,
      kind: "STOCK",
      details: {},
    },
  });
  const batch = await db.stockBatch.create({
    data: {
      productId,
      origin: "OPENING",
      openingItemId: openingItem.id,
      originalQuantity: 13,
      unitCost: "80.000000",
      balances: {
        create: { location: "SHOP", bucket: "AVAILABLE", quantity: 13 },
      },
    },
  });
  const stockBefore = await db.stockBatch.findUnique({
    where: { id: batch.id },
    include: { balances: true },
  });
  const body = {
    version: 1,
    name,
    model: "NEW",
    unit: "pcs",
    defaultSellingPrice: "125.50",
    warrantyMonths: 12,
  };
  await request(app.getHttpServer())
    .get(`/api/v1/products/${productId}`)
    .expect(401);
  assert.equal((await post(staff, `products/${productId}`, body)).status, 403);
  await owner
    .post(`/api/v1/products/${productId}`)
    .set("Origin", origin())
    .send(body)
    .expect(403);
  for (const invalid of [
    { ...body, stock: { total: "999" } },
    { ...body, latestPurchasePrice: "1" },
    { ...body, typeId: randomUUID() },
    { ...body, warrantyMonths: -1 },
    { ...body, defaultSellingPrice: "1.234" },
  ])
    assert.equal(
      (await post(owner, `products/${productId}`, invalid)).status,
      400,
    );
  assert.equal(
    (await post(owner, `products/${productId}`, { ...body, unit: "piece" }))
      .status,
    409,
  );
  assert.equal(
    (await owner.get(`/api/v1/products/${productId}`).expect(200)).body.data
      .unitEditable,
    false,
  );
  const results = await Promise.all([
    post(owner, `products/${productId}`, body),
    post(owner, `products/${productId}`, { ...body, model: "RACE" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const current = (await owner.get(`/api/v1/products/${productId}`).expect(200))
    .body.data;
  assert.equal(current.version, 2);
  assert.equal(current.defaultSellingPrice, "125.50");
  assert.equal(current.warrantyMonths, 12);
  assert.deepEqual(
    await db.stockBatch.findUnique({
      where: { id: batch.id },
      include: { balances: true },
    }),
    stockBefore,
  );
  assert.equal(
    await db.auditLog.count({
      where: { resourceId: productId, action: "PRODUCT_UPDATED" },
    }),
    1,
  );
  const duplicate = await post(owner, "products", {
    typeId: type.id,
    name,
    category: name,
    model: "DUPLICATE",
    unit: "pcs",
  });
  assert.equal(duplicate.status, 201);
  assert.equal(
    (
      await post(owner, `products/${productId}`, {
        ...body,
        version: 2,
        model: "DUPLICATE",
      })
    ).status,
    409,
  );
  assert.equal(
    (await owner.get(`/api/v1/products/${productId}`).expect(200)).body.data
      .version,
    2,
  );
  const stored = await db.product.findUniqueOrThrow({
    where: { id: productId },
  });
  await db.product.update({
    where: { id: productId },
    data: { active: false },
  });
  assert.equal(
    (
      await post(owner, `products/${productId}`, {
        ...body,
        version: stored.version,
      })
    ).status,
    400,
  );
});

test("customer icon editing validates contacts and versions while preserving customer history", async () => {
  const post = async (agent: TestAgent, path: string, body: object) =>
    agent
      .post("/api/v1/" + path)
      .set("Origin", origin())
      .set("X-CSRF-Token", await csrf(agent))
      .send(body);
  const created = await post(owner, "customers", {
    name: "Original " + id,
    phone: "01700000001",
    address: "Betagi",
  });
  assert.equal(created.status, 201);
  const customer = created.body.data;
  const path = `customers/${customer.id}`;
  const draft = await db.sale.create({
    data: {
      customerId: customer.id,
      invoiceSnapshot: { customerName: customer.name },
      status: "DRAFT",
    },
  });
  const before = await db.sale.findUnique({ where: { id: draft.id } });
  const body = {
    version: customer.version,
    name: "Updated " + id,
    phone: "01900000002",
    address: "Dhaka",
  };
  await request(app.getHttpServer())
    .get("/api/v1/" + path)
    .expect(401);
  await owner
    .post("/api/v1/" + path)
    .set("Origin", origin())
    .send(body)
    .expect(403);
  await owner.get(`/api/v1/customers/${randomUUID()}`).expect(404);
  const permission = await db.permission.findUniqueOrThrow({
    where: { code: "sales.manage" },
  });
  const role = await db.role.create({
    data: {
      code: "READ_EDIT_" + id,
      name: "Read only",
      permissions: { create: { permissionId: permission.id } },
    },
  });
  await db.user.create({
    data: {
      login: "edit-reader-" + id,
      name: "Read only",
      passwordHash: await hash(password, passwordOptions),
      roles: { create: { roleId: role.id } },
    },
  });
  const reader = request.agent(app.getHttpServer());
  assert.equal((await login(reader, "edit-reader-" + id)).status, 201);
  await reader.get("/api/v1/" + path).expect(200);
  assert.equal((await post(reader, path, body)).status, 403);
  for (const invalid of [
    { ...body, name: " " },
    { ...body, phone: "bad" },
    { ...body, address: "" },
    { ...body, due: "1" },
    { ...body, active: false },
    { ...body, version: 0 },
  ])
    assert.equal((await post(owner, path, invalid)).status, 400);
  const result = await Promise.all([
    post(owner, path, body),
    post(owner, path, { ...body, name: "Concurrent " + id }),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
  const updated = (await owner.get("/api/v1/" + path).expect(200)).body.data;
  assert.equal(updated.id, customer.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.phone, body.phone);
  assert.equal(updated.address, body.address);
  assert.equal(updated.due, customer.due);
  assert.equal(updated.totalSales, customer.totalSales);
  assert.equal(updated.active, true);
  assert.deepEqual(
    await db.sale.findUnique({ where: { id: draft.id } }),
    before,
  );
  assert.equal(
    await db.auditLog.count({
      where: { resourceId: customer.id, action: "CUSTOMER_UPDATED" },
    }),
    1,
  );
});

test("invoice notes are read from the saved sale snapshot with safe empty defaults", async () => {
  const customer = await db.customer.create({
    data: { name: "Notes " + id, phone: "01700000001", address: "Betagi" },
    select: { id: true },
  });
  const snapshots = [
    { notes: "Handle with care\nDeliver after 5 PM" },
    { notes: "" },
    {},
    { notes: 12 },
  ];
  const invoices = [];
  for (const [i, snapshot] of snapshots.entries())
    invoices.push(
      await db.sale.create({
        data: {
          customer: { connect: { id: customer.id } },
          status: "CONFIRMED",
          soldAt: new Date("2026-11-25T09:00:00Z"),
          invoiceNumber: "NOTES-" + id + "-" + i,
          invoiceSnapshot: snapshot,
          subtotal: "10",
          total: "10",
          posting: {
            create: {
              actorId: ownerId,
              kind: "TEST_SALE",
              sourceCode: "notes-" + id + "-" + i,
            },
          },
        },
      }),
    );
  const response = await owner
    .get(`/api/v1/customers/${customer.id}/sales`)
    .expect(200);
  for (const [i, invoice] of invoices.entries()) {
    const result = response.body.data.items.find(
      (row: { id: string }) => row.id === invoice.id,
    );
    assert.equal(result.notes, i === 0 ? snapshots[0].notes : "");
  }
});
