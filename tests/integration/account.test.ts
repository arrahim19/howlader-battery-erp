import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApp } from "../../apps/api/src/app";
import { DatabaseService } from "../../apps/api/src/database.service";
import { AccountMailService } from "../../apps/api/src/account-mail";
import { digest, hashPassword, verifyPassword } from "../../apps/api/src/auth";
import { settings } from "../../apps/api/src/config";

assert.equal(process.env.ERP_INTEGRATION_TEST, "true");
assert(new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"));
type Agent = ReturnType<typeof request.agent>;
let app: INestApplication;
let db: DatabaseService;
let mail: AccountMailService;
const sent: { to: string; subject: string; text: string }[] = [];
const deliver = async (to: string, subject: string, text: string) => {
  sent.push({ to, subject, text });
};
const password = randomBytes(24).toString("base64url");
const newPassword = "583194";
const origin = () => settings().origin;
const agent = () => request.agent(app.getHttpServer());
async function csrf(client: Agent) {
  return (await client.get("/api/v1/auth/csrf").expect(200)).body.data
    .token as string;
}
async function post(client: Agent, path: string, body: object) {
  const token = await csrf(client);
  return client
    .post("/api/v1" + path)
    .set("Origin", origin())
    .set("X-CSRF-Token", token)
    .send(body);
}
async function login(client: Agent, login: string, secret = password) {
  return post(client, "/auth/login", { login, password: secret });
}
async function identity(admin = true, verified = false) {
  const loginName = "account-" + randomUUID();
  const email = `${loginName}@example.com`;
  const role = await db.role.upsert({
    where: { code: admin ? "ACCOUNT_TEST_ADMIN" : "ACCOUNT_TEST_STAFF" },
    update: {},
    create: {
      code: admin ? "ACCOUNT_TEST_ADMIN" : "ACCOUNT_TEST_STAFF",
      name: "Account test role",
      builtIn: false,
    },
  });
  if (admin) {
    const permission = await db.permission.upsert({
      where: { code: "access.manage" },
      update: {},
      create: { code: "access.manage", name: "Manage accounts" },
    });
    await db.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
  const user = await db.user.create({
    data: {
      name: "Account test owner",
      login: loginName,
      passwordHash: await hashPassword(password),
      email: verified ? email : null,
      emailVerifiedAt: verified ? new Date() : null,
      roles: { create: { roleId: role.id } },
    },
  });
  const client = agent();
  assert.equal((await login(client, loginName)).status, 201);
  return { user, client, email, login: loginName };
}
const tokenFromLastEmail = () => {
  const match = sent.at(-1)?.text.match(/#token=([a-f0-9]{64})/);
  assert(match);
  return match[1];
};

test("native password recovery sends a reset link without cookies and retains browser CSRF, origin and shared throttling", async () => {
  const { user, email } = await identity(true, true);
  const native = () =>
    request(app.getHttpServer())
      .post("/api/v1/auth/mobile/forgot-password")
      .send({ email });
  const result = await native().expect(201);
  const token = tokenFromLastEmail();
  assert.equal(sent.at(-1)?.to, email);
  assert.equal(
    await db.accountEmailToken.count({
      where: { userId: user.id, tokenHash: digest(token) },
    }),
    1,
  );
  const unknown = await request(app.getHttpServer())
    .post("/api/v1/auth/mobile/forgot-password")
    .send({ email: randomUUID() + "@example.com" })
    .expect(201);
  assert.deepEqual(unknown.body, result.body);
  await request(app.getHttpServer())
    .post("/api/v1/auth/mobile/forgot-password")
    .set("Origin", "https://untrusted.example")
    .send({ email })
    .expect(403);
  await request(app.getHttpServer())
    .post("/api/v1/auth/mobile/forgot-password")
    .send({ email: "invalid" })
    .expect(400);
  await request(app.getHttpServer())
    .post("/api/v1/auth/forgot-password")
    .send({ email })
    .expect(403);
  for (let i = 0; i < 4; i++) await native().expect(201);
  assert.equal(
    (await post(agent(), "/auth/forgot-password", { email })).status,
    429,
  );
});
before(async () => {
  app = await createApp();
  await app.init();
  db = app.get(DatabaseService);
  mail = app.get(AccountMailService);
  mail.configured = () => true;
  mail.send = deliver;
});
after(async () => {
  await app?.close();
});

test("user name editing validates version, access, CSRF, and live session identity without exposing secrets", async () => {
  const { user, client } = await identity();
  const staff = await identity(false);
  const path = `/users/${user.id}/profile`;
  const body = { name: "  Rahim  ", version: user.version };
  await request(app.getHttpServer())
    .post("/api/v1" + path)
    .set("Origin", origin())
    .send(body)
    .expect(401);
  assert.equal((await post(staff.client, path, body)).status, 403);
  await client
    .post("/api/v1" + path)
    .set("Origin", origin())
    .send(body)
    .expect(403);
  assert.equal((await post(client, path, { ...body, name: "  " })).status, 400);
  assert.equal(
    (await post(client, path, { ...body, roles: ["OWNER"] })).status,
    400,
  );
  const saved = await post(client, path, body);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.data.name, "Rahim");
  assert.equal((await post(client, path, body)).status, 409);
  assert.equal(
    (await client.get("/api/v1/auth/me").expect(200)).body.data.name,
    "Rahim",
  );
  const users = (await client.get("/api/v1/users").expect(200)).body.data;
  assert(!JSON.stringify(users).includes("passwordHash"));
  assert.equal(
    users.find((row: { id: string }) => row.id === user.id).version,
    user.version + 1,
  );
});

test("changing password requires the current password, revokes all sessions, and invalidates recovery tokens", async () => {
  const { user, client, login: loginName } = await identity();
  const second = agent();
  assert.equal((await login(second, loginName)).status, 201);
  await db.accountEmailToken.create({
    data: {
      userId: user.id,
      purpose: "RESET_PASSWORD",
      email: "fixture@example.com",
      tokenHash: digest(randomBytes(32).toString("hex")),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const body = { currentPassword: password, newPassword };
  assert.equal(
    (
      await post(client, "/auth/change-password", {
        ...body,
        newPassword: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(client, "/auth/change-password", {
        ...body,
        currentPassword: "wrong",
      })
    ).status,
    400,
  );
  await client.get("/api/v1/auth/me").expect(200);
  assert.equal((await post(client, "/auth/change-password", body)).status, 201);
  await client.get("/api/v1/auth/me").expect(401);
  await second.get("/api/v1/auth/me").expect(401);
  assert.equal(
    await db.accountEmailToken.count({ where: { userId: user.id } }),
    0,
  );
  assert(
    await verifyPassword(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordHash,
      newPassword,
    ),
  );
  assert.equal((await login(agent(), loginName)).status, 401);
  assert.equal((await login(agent(), loginName, newPassword)).status, 201);
});

test("email linking requires password and inbox proof, stores only token digests, and keeps the old login", async () => {
  const { user, client, email, login: loginName } = await identity();
  assert.equal(
    (
      await post(client, "/auth/email/request-verification", {
        email,
        currentPassword: "wrong",
      })
    ).status,
    400,
  );
  const response = await post(client, "/auth/email/request-verification", {
    email: email.toUpperCase(),
    currentPassword: password,
  });
  assert.equal(response.status, 201);
  const token = tokenFromLastEmail();
  assert(!JSON.stringify(response.body).includes(token));
  assert.equal(sent.at(-1)?.to, email);
  const stored = await db.accountEmailToken.findUniqueOrThrow({
    where: { tokenHash: digest(token) },
  });
  assert(stored.expiresAt.getTime() > Date.now());
  assert.notEqual(stored.tokenHash, token);
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).email,
    null,
  );
  assert.equal((await login(agent(), email)).status, 401);
  assert.equal(
    (await post(agent(), "/auth/email/verify", { token })).status,
    201,
  );
  assert.equal(
    (await post(agent(), "/auth/email/verify", { token })).status,
    400,
  );
  await client.get("/api/v1/auth/me").expect(401);
  const emailAgent = agent();
  assert.equal((await login(emailAgent, email.toUpperCase())).status, 201);
  assert.equal((await login(agent(), loginName)).status, 201);
  assert.equal(
    (await emailAgent.get("/api/v1/auth/account").expect(200)).body.data.email,
    email,
  );
  const other = await identity();
  assert.equal(
    (
      await post(other.client, "/auth/email/request-verification", {
        email,
        currentPassword: password,
      })
    ).status,
    409,
  );
});

test("forgot password uses a generic response, supersedes old links, and resets once under concurrent requests", async () => {
  const { user, client, email, login: loginName } = await identity(true, true);
  const anonymous = agent();
  const existing = await post(anonymous, "/auth/forgot-password", { email });
  const firstToken = tokenFromLastEmail();
  const count = sent.length;
  const unknown = await post(anonymous, "/auth/forgot-password", {
    email: `${randomUUID()}@example.com`,
  });
  assert.equal(unknown.status, 201);
  assert.deepEqual(unknown.body.data, existing.body.data);
  assert.equal(sent.length, count);
  assert.equal(
    (await post(anonymous, "/auth/forgot-password", { email })).status,
    201,
  );
  const token = tokenFromLastEmail();
  assert.notEqual(token, firstToken);
  assert.equal(
    (
      await post(anonymous, "/auth/reset-password", {
        token: firstToken,
        newPassword,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(anonymous, "/auth/reset-password", {
        token,
        newPassword: "short",
      })
    ).status,
    400,
  );
  const results = await Promise.all([
    post(agent(), "/auth/reset-password", { token, newPassword }),
    post(agent(), "/auth/reset-password", { token, newPassword }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
  await client.get("/api/v1/auth/me").expect(401);
  assert.equal(
    (await post(anonymous, "/auth/reset-password", { token, newPassword }))
      .status,
    400,
  );
  assert.equal((await login(agent(), email, newPassword)).status, 201);
  assert.equal((await login(agent(), loginName, newPassword)).status, 201);
  assert.equal((await login(agent(), loginName)).status, 401);
  assert.equal(
    await db.auditLog.count({
      where: { action: "AUTH_PASSWORD_RESET", resourceId: user.id },
    }),
    1,
  );
});

test("expired and disabled-account recovery links fail without changing passwords", async () => {
  const { user, email } = await identity(true, true);
  assert.equal(
    (await post(agent(), "/auth/forgot-password", { email })).status,
    201,
  );
  const token = tokenFromLastEmail();
  await db.accountEmailToken.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await post(agent(), "/auth/reset-password", { token, newPassword }))
      .status,
    400,
  );
  assert.equal(
    (await post(agent(), "/auth/forgot-password", { email })).status,
    201,
  );
  const disabledToken = tokenFromLastEmail();
  await db.user.update({ where: { id: user.id }, data: { active: false } });
  assert.equal(
    (
      await post(agent(), "/auth/reset-password", {
        token: disabledToken,
        newPassword,
      })
    ).status,
    400,
  );
  const sentCount = sent.length;
  assert.equal(
    (await post(agent(), "/auth/forgot-password", { email })).status,
    201,
  );
  assert.equal(sent.length, sentCount);
  assert(
    await verifyPassword(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordHash,
      password,
    ),
  );
});

test("SMTP setup and delivery failures are honest and never leave usable emailed tokens", async () => {
  const { user, client, email } = await identity(true, true);
  mail.configured = () => false;
  try {
    assert.equal(
      (await client.get("/api/v1/auth/account").expect(200)).body.data
        .mailConfigured,
      false,
    );
    assert.equal(
      (await post(agent(), "/auth/forgot-password", { email })).status,
      503,
    );
  } finally {
    mail.configured = () => true;
  }
  mail.send = async () => {
    throw new Error("Fake delivery failure");
  };
  try {
    assert.equal(
      (
        await post(client, "/auth/email/request-verification", {
          email: `new-${email}`,
          currentPassword: password,
        })
      ).status,
      503,
    );
    assert.equal(
      (await post(agent(), "/auth/forgot-password", { email })).status,
      201,
    );
    assert.equal(
      await db.accountEmailToken.count({ where: { userId: user.id } }),
      0,
    );
  } finally {
    mail.send = deliver;
  }
});

test("password recovery requires Origin and CSRF and limits repeated email requests", async () => {
  const email = `${randomUUID()}@example.com`;
  await agent()
    .post("/api/v1/auth/forgot-password")
    .set("Origin", origin())
    .send({ email })
    .expect(403);
  const client = agent();
  await client
    .post("/api/v1/auth/forgot-password")
    .set("Origin", "https://example.invalid")
    .set("X-CSRF-Token", await csrf(client))
    .send({ email })
    .expect(403);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await post(client, "/auth/forgot-password", { email })).status,
      201,
    );
  assert.equal(
    (await post(client, "/auth/forgot-password", { email })).status,
    429,
  );
});
