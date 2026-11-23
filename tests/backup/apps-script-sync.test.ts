import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import {
  DriveSyncTransport,
  DriveSyncError,
  encryptSnapshot,
  decryptSnapshot,
  newShopEncryptionKey,
  snapshotHash,
  validateDriveEndpoint,
} from "../../packages/drive-sync/src";

type Head = { revision: number; writeId?: string; payloadHash?: string };
type Result = {
  ok: boolean;
  data?: Record<string, unknown> & {
    revision?: number;
    leaseId?: string;
    head?: Head;
  };
  error?: { code: string; message: string };
};
type Pairing = {
  protocol: number;
  serviceId: string;
  shopId: string;
  deviceId: string;
  token: string;
  deviceName: string;
  shopName: string;
};
function fixture() {
  const properties = new Map<string, string>();
  const files = new Map<string, FakeFile>();
  const folders = new Map<string, FakeFolder>();
  const logs: string[] = [];
  const cache = new Map<string, string>();
  let googleIdentity = { sub: "google-owner-1", email: "owner@example.com", email_verified: true, name: "Owner" };
  let exchangeSuccess = true;
  const googleCalls: string[] = [];
  let failCommit = false;
  let locked = false;
  const iterator = <T>(entries: T[]) => {
    let index = 0;
    return {
      hasNext: () => index < entries.length,
      next: () => entries[index++],
    };
  };
  class FakeFile {
    id = randomUUID();
    constructor(
      public name: string,
      public text: string,
    ) {
      files.set(this.id, this);
    }
    getId() {
      return this.id;
    }
    getBlob() {
      return { getDataAsString: () => this.text };
    }
    setContent(text: string) {
      this.text = text;
      return this;
    }
  }
  class FakeFolder {
    id = randomUUID();
    children: FakeFile[] = [];
    constructor(public name: string) {
      folders.set(this.id, this);
    }
    getId() {
      return this.id;
    }
    getUrl() {
      return "https://drive.google.com/drive/folders/" + this.id;
    }
    createFolder(name: string) {
      return new FakeFolder(name);
    }
    createFile(name: string, text: string) {
      const file = new FakeFile(name, text);
      this.children.push(file);
      return file;
    }
    getFilesByName(name: string) {
      return iterator(this.children.filter((file) => file.name === name));
    }
  }
  const context = vm.createContext({
    console: { log: (message: string) => logs.push(message) },
    Date,
    Number,
    JSON,
    CacheService: { getScriptCache: () => ({ get: (key: string) => cache.get(key) ?? null, put: (key: string, value: string) => cache.set(key, value), remove: (key: string) => cache.delete(key) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    HtmlService: { createHtmlOutput: (html: string) => html },
    UrlFetchApp: { fetch: (url: string, options: { payload?: Record<string, string>; headers?: Record<string, string>; followRedirects: boolean }) => {
      googleCalls.push(url); assert.equal(options.followRedirects, false);
      if (url === "https://oauth2.googleapis.com/token") {
        assert.equal(options.payload?.client_secret, "test-client-secret"); assert.ok(options.payload?.code_verifier);
        return { getResponseCode: () => exchangeSuccess ? 200 : 400, getContentText: () => JSON.stringify(exchangeSuccess ? { access_token: "trusted-google-access-token" } : { error: "invalid_grant" }) };
      }
      assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo"); assert.equal(options.headers?.Authorization, "Bearer trusted-google-access-token");
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(googleIdentity) };
    } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => properties.get(key) ?? null,
        getProperties: () => Object.fromEntries(properties),
        setProperty: (key: string, value: string) => {
          if (failCommit && key.startsWith("HB_HEAD_")) {
            failCommit = false;
            throw Error("Simulated interrupted commit");
          }
          properties.set(key, value);
        },
        deleteProperty: (key: string) => properties.delete(key),
      }),
    },
    DriveApp: {
      createFolder: (name: string) => new FakeFolder(name),
      getFolderById: (id: string) => {
        assert.ok(folders.has(id));
        return folders.get(id)!;
      },
      getFileById: (id: string) => {
        assert.ok(files.has(id));
        return files.get(id)!;
      },
    },
    LockService: {
      getScriptLock: () => {
        let held = false;
        return {
          tryLock: () => {
            if (locked) return false;
            locked = true;
            held = true;
            return true;
          },
          hasLock: () => held,
          releaseLock: () => {
            held = false;
            locked = false;
          },
        };
      },
    },
    Utilities: {
      getUuid: randomUUID,
      base64EncodeWebSafe: (bytes: number[]) => Buffer.from(bytes).toString("base64url"),
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm: string, value: string) => [
        ...createHash("sha256").update(value).digest(),
      ],
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text: string) => ({ setMimeType: () => text }),
    },
    MimeType: { PLAIN_TEXT: "text/plain" },
  });
  vm.runInContext(readFileSync("google-apps-script/Code.gs", "utf8"), context);
  vm.runInContext(readFileSync("google-apps-script/GoogleLogin.gs", "utf8"), context);
  const invoke = (name: string, ...args: unknown[]) => context[name](...args);
  invoke("setupHowladerSync");
  const pairing = (shop: string, device: string) =>
    JSON.parse(
      [...files.values()].find(
        (file) => file.name === `PRIVATE-PAIRING-${shop}-${device}.json`,
      )!.text,
    ) as Pairing;
  const post = (
    pair: Pairing,
    op: string,
    body: Record<string, unknown> = {},
  ) =>
    JSON.parse(
      invoke("doPost", {
        postData: {
          contents: JSON.stringify({
            protocol: 1,
            serviceId: pair.serviceId,
            token: pair.token,
            op,
            ...body,
          }),
        },
      }),
    ) as Result;
  const push = (
    pair: Pairing,
    leaseId: string,
    baseRevision: number,
    writeId = randomUUID(),
    payload = "encrypted-test-snapshot",
  ) => {
    const body = {
      leaseId,
      baseRevision,
      writeId,
      payload,
      payloadFormat: "a256gcm-v1",
      payloadHash: createHash("sha256").update(payload).digest("hex"),
    };
    return { body, result: post(pair, "push", body) };
  };
  return {
    context,
    properties,
    files,
    logs,
    pairing,
    post,
    push,
    invoke,
    cache, googleCalls,
    setGoogleIdentity: (value: typeof googleIdentity) => { googleIdentity = value; },
    setExchangeSuccess: (value: boolean) => { exchangeSuccess = value; },
    failNextCommit: () => {
      failCommit = true;
    },
  };
}

test("Apps Script setup is repeatable and keeps credentials out of logs/properties", () => {
  const f = fixture();
  const before = f.files.size;
  const phone = f.pairing("Betagi", "Phone");
  f.invoke("setupHowladerSync");
  assert.equal(f.files.size, before);
  assert.equal(f.pairing("Betagi", "Phone").token, phone.token);
  assert.equal(JSON.stringify(f.logs).includes(phone.token), false);
  assert.equal(
    JSON.stringify([...f.properties.values()]).includes(phone.token),
    false,
  );
  const health = JSON.parse(f.invoke("doGet"));
  assert.equal(health.data.ready, true);
  assert.equal(JSON.stringify(health).includes(phone.token), false);
});

function loginFixture() {
  const f = fixture();
  f.properties.set("HB_GOOGLE_CLIENT_ID", "test-client-id"); f.properties.set("HB_GOOGLE_CLIENT_SECRET", "test-client-secret"); f.properties.set("HB_DEPLOYMENT_URL", "https://script.google.com/macros/s/test/exec");
  f.invoke("setupHowladerGoogleLogin");
  function begin() {
    const verifier = createHash("sha256").update(randomUUID()).digest("hex");
    const requestId = randomUUID(); const proposedShopKey = createHash("sha256").update(randomUUID()).digest("hex");
    const result = f.post(f.pairing("Betagi", "Phone"), "loginStart", { token: undefined, requestId, verifier: undefined, challenge: createHash("sha256").update(verifier).digest("hex"), proposedShopKey, deviceId: randomUUID(), deviceName: "New PC" });
    assert.equal(result.ok, true);
    const url = new URL(result.data!.url as string);
    assert.equal(url.origin, "https://accounts.google.com"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    return { requestId, verifier, proposedShopKey, state: url.searchParams.get("state")! };
  }
  const poll = (flow: ReturnType<typeof begin>, overrides: Record<string, unknown> = {}) => f.post(f.pairing("Betagi", "Phone"), "loginPoll", { token: undefined, requestId: flow.requestId, verifier: flow.verifier, ...overrides });
  const callback = (flow: ReturnType<typeof begin>) => f.invoke("doGet", { pathInfo: "oauth/callback", parameter: { code: "code-from-google", state: flow.state } }) as string;
  return { ...f, begin, poll, callback };
}
test("Google login verifies identity through code+PKCE exchange and recovers the same shop key on another PC", () => {
  const f = loginFixture(); const flow = f.begin();
  assert.equal(f.poll(flow).data?.status, "pending");
  assert.equal(f.poll(flow, { verifier: "0".repeat(64) }).error?.code, "ACCESS_DENIED");
  assert.match(f.callback(flow), /sign-in complete/);
  const grant = f.poll(flow).data?.grant as { shopKey: string; pairing: Pairing; user: { id: string } };
  assert.equal(grant.shopKey, flow.proposedShopKey); assert.equal(grant.user.id, "google-owner-1");
  assert.equal(f.post(grant.pairing, "status").ok, true);
  const count = f.googleCalls.length;
  assert.doesNotMatch(f.callback(flow), /sign-in complete/); assert.equal(f.googleCalls.length, count);
  assert.deepEqual(f.poll(flow).data?.grant, grant);
  const second = f.begin(); f.callback(second);
  const recovered = f.poll(second).data?.grant as typeof grant;
  assert.equal(recovered.shopKey, grant.shopKey); assert.equal(recovered.pairing.shopId, grant.pairing.shopId); assert.notEqual(recovered.pairing.deviceId, grant.pairing.deviceId);
  assert.equal(JSON.stringify(f.logs).includes(grant.shopKey), false); assert.equal(JSON.stringify(f.logs).includes(grant.pairing.token), false);
});
test("Google login rejects an unverified/unapproved email and never trusts an email supplied by the app", () => {
  const f = loginFixture();
  f.setGoogleIdentity({ sub: "attacker", email: "attacker@example.com", email_verified: true, name: "Other" });
  const unknown = f.begin(); f.callback(unknown); assert.equal(f.poll(unknown, { email: "owner@example.com" }).error?.code, "ACCESS_DENIED");
  f.setGoogleIdentity({ sub: "google-owner-1", email: "owner@example.com", email_verified: false, name: "Owner" });
  const unverified = f.begin(); f.callback(unverified); assert.equal(f.poll(unverified).error?.code, "LOGIN_DENIED");
  f.setExchangeSuccess(false);
  const failed = f.begin(); f.callback(failed); assert.equal(f.poll(failed).error?.code, "LOGIN_DENIED");
});
test("Google login preserves existing encrypted data when its recovery key is missing and immediately honors revoked email access", () => {
  const f = loginFixture(); const first = f.begin(); f.callback(first);
  const grant = f.poll(first).data?.grant as { pairing: Pairing; shopKey: string };
  const claimed = f.post(grant.pairing, "claim"); f.push(grant.pairing, claimed.data!.leaseId!, 0);
  f.properties.delete("HB_SHOP_KEY_" + grant.pairing.shopId);
  const second = f.begin(); f.callback(second); assert.equal(f.poll(second).error?.code, "KEY_RECOVERY_REQUIRED");
  f.properties.set("HB_LOGIN_EMAILS", "{}"); assert.equal(f.post(grant.pairing, "status").error?.code, "ACCESS_DENIED");
});

test("Apps Script isolates shops and rejects missing/invalid credentials and remote setup", () => {
  const f = fixture();
  const phone = f.pairing("Betagi", "Phone");
  const other = f.pairing("Mirzaganj", "Phone");
  assert.equal(
    f.post(phone, "status", { token: "wrong" }).error?.code,
    "ACCESS_DENIED",
  );
  assert.equal(
    f.post(phone, "status", { serviceId: "wrong-service" }).error?.code,
    "WRONG_SERVICE",
  );
  assert.equal(f.post(phone, "setupHowladerSync").error?.code, "BAD_REQUEST");
  const result = f.post(phone, "status", { shopId: other.shopId });
  assert.equal((result.data?.shop as { id: string }).id, phone.shopId);
  assert.equal(
    f.post(phone, "push", { writeId: randomUUID(), baseRevision: 0 }).ok,
    false,
  );
});

test("Apps Script enforces one writing device, revisions and encrypted snapshot checksums", () => {
  const f = fixture();
  const phone = f.pairing("Betagi", "Phone");
  const pc = f.pairing("Betagi", "Desktop");
  const claim = f.post(phone, "claim");
  const leaseId = claim.data!.leaseId!;
  assert.equal(f.post(pc, "claim").error?.code, "DEVICE_BUSY");
  const write = f.push(phone, leaseId, 0);
  assert.equal(write.result.data?.revision, 1);
  assert.equal(
    f.post(phone, "push", {
      ...write.body,
      writeId: randomUUID(),
      baseRevision: 0,
    }).error?.code,
    "REVISION_CONFLICT",
  );
  assert.equal(
    f.post(phone, "push", {
      ...write.body,
      writeId: randomUUID(),
      payloadHash: "0".repeat(64),
    }).error?.code,
    "BAD_REQUEST",
  );
  const own = f.post(phone, "pull");
  assert.equal(own.data?.payload, "encrypted-test-snapshot");
  const other = f.post(f.pairing("Mirzaganj", "Phone"), "pull", {
    shopId: phone.shopId,
  });
  assert.equal(other.data?.head?.revision, 0);
  assert.equal(f.post(phone, "release", { leaseId }).ok, true);
  assert.equal(f.post(pc, "claim").ok, true);
});

test("a lost response or interrupted Drive commit retries without a second revision/file", () => {
  const f = fixture();
  const pair = f.pairing("Betagi", "Phone");
  const leaseId = f.post(pair, "claim").data!.leaseId!;
  f.failNextCommit();
  const first = f.push(pair, leaseId, 0);
  assert.equal(first.result.error?.code, "SERVICE_UNAVAILABLE");
  const count = f.files.size;
  const retry = f.post(pair, "push", first.body);
  assert.equal(retry.data?.revision, 1);
  assert.equal(f.files.size, count);
  assert.equal(f.post(pair, "push", first.body).data?.repeated, true);
  f.push(pair, leaseId, 1, randomUUID(), "next-snapshot");
  const olderRetry = f.post(pair, "push", first.body);
  assert.equal(olderRetry.data?.revision, 1);
  assert.equal(olderRetry.data?.currentRevision, 2);
  assert.equal(f.post(pair, "status").data?.head?.revision, 2);
  assert.equal(
    f.post(pair, "push", {
      ...first.body,
      payload: "changed",
      payloadHash: createHash("sha256").update("changed").digest("hex"),
    }).error?.code,
    "OPERATION_REUSED",
  );
});

test("a revoked device cannot read or write and setup does not reactivate it", () => {
  const f = fixture();
  const pair = f.pairing("Betagi", "Phone");
  f.post(pair, "claim");
  f.properties.set("HB_REVOKE_DEVICE_ID", pair.deviceId);
  f.invoke("revokeHowladerDevice");
  f.invoke("setupHowladerSync");
  assert.equal(f.post(pair, "pull").error?.code, "ACCESS_DENIED");
  assert.equal(f.post(pair, "claim").error?.code, "ACCESS_DENIED");
  assert.equal(f.post(f.pairing("Betagi", "Desktop"), "claim").ok, true);
});

test("the shared client encrypts, uploads, downloads and decrypts a snapshot through the Apps Script protocol", async () => {
  const f = fixture();
  const pair = f.pairing("Betagi", "Phone");
  const send: typeof fetch = async (url, init) => {
    assert.equal(
      String(url),
      "https://script.google.com/macros/s/test-deployment/exec",
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(
      init?.headers && (init.headers as Record<string, string>)["Content-Type"],
      "text/plain;charset=UTF-8",
    );
    assert.equal(String(url).includes(pair.token), false);
    return new Response(
      f.invoke("doPost", { postData: { contents: init!.body } }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const transport = new DriveSyncTransport(
    "https://script.google.com/macros/s/test-deployment/exec",
    pair as typeof pair & { protocol: 1 },
    send,
  );
  const key = newShopEncryptionKey();
  const value = {
    schemaVersion: 1,
    invoices: [{ number: "HB-0001", total: "9500.00" }],
  };
  const payload = await encryptSnapshot(
    value,
    key,
    pair.serviceId,
    pair.shopId,
  );
  assert.equal(payload.includes("9500"), false);
  const claim = await transport.claim();
  const pending = {
    leaseId: claim.leaseId,
    baseRevision: 0,
    writeId: randomUUID(),
    payload,
    payloadFormat: "a256gcm-v1" as const,
    payloadHash: await snapshotHash(payload),
  };
  assert.equal((await transport.push(pending)).revision, 1);
  assert.equal((await transport.push(pending)).repeated, true);
  const pulled = await transport.pull();
  assert.equal(pulled.payload, payload);
  assert.deepEqual(
    await decryptSnapshot(pulled.payload!, key, pair.serviceId, pair.shopId),
    value,
  );
  await assert.rejects(
    decryptSnapshot(payload, key, pair.serviceId, "another-shop"),
  );
  await assert.rejects(
    decryptSnapshot(
      payload,
      newShopEncryptionKey(),
      pair.serviceId,
      pair.shopId,
    ),
  );
  assert.equal((await transport.pull(1)).unchanged, true);
  assert.equal((await transport.release(claim.leaseId)).released, true);
  assert.throws(
    () => validateDriveEndpoint("https://example.com/steal-token"),
    DriveSyncError,
  );
  assert.throws(
    () => validateDriveEndpoint("https://script.google.com/macros/s/test/dev"),
    DriveSyncError,
  );
});

test("the shared client preserves the distinction between connection failure and a rejected write", async () => {
  const f = fixture();
  const pair = f.pairing("Betagi", "Phone");
  const endpoint = "https://script.google.com/macros/s/test/exec";
  const offline = new DriveSyncTransport(
    endpoint,
    pair as typeof pair & { protocol: 1 },
    async () => {
      throw new Error("network down");
    },
  );
  await assert.rejects(
    offline.claim(),
    (error: unknown) =>
      error instanceof DriveSyncError &&
      error.retryable &&
      error.code === "NETWORK",
  );
  const stale = new DriveSyncTransport(
    endpoint,
    pair as typeof pair & { protocol: 1 },
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "REVISION_CONFLICT", message: "Newer backup exists" },
        }),
      ),
  );
  await assert.rejects(
    stale.claim(),
    (error: unknown) =>
      error instanceof DriveSyncError &&
      !error.retryable &&
      error.code === "REVISION_CONFLICT",
  );
});
