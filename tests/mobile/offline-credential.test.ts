import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import type { CurrentUser } from "../../apps/mobile/src/lib/client";
import { passwordVerifier } from "../../apps/mobile/src/lib/offline/password";
import {
  credentialSalt,
  enrollCredential,
  unlockCredential,
} from "../../apps/mobile/src/lib/offline/credentials";

test("WebCrypto proofs preserve PBKDF2 compatibility and native offline account checks", async () => {
  const values = new Map<string, string>();
  const storage = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const origin = "https://erp.test",
    login = "owner@example.com",
    password = "Device-test-password";
  const salt = new Uint8Array(32).fill(17);
  const proof = await passwordVerifier(password, salt);
  assert.deepEqual(proof.hash, [
    ...pbkdf2Sync(password, salt, 210000, 32, "sha256"),
  ]);
  const user = { id: "owner", login, shop: { id: "shop" } } as CurrentUser;
  const session = {
    origin,
    accessToken: "private-token",
    expiresAt: "2099-01-01",
  };
  await enrollCredential(
    storage,
    salt,
    origin,
    login,
    password,
    session,
    user,
    proof,
  );
  assert.deepEqual(await credentialSalt(storage, origin, login), [...salt]);
  assert.equal(
    await credentialSalt(storage, "https://another.test", login),
    null,
  );
  assert.equal(
    await credentialSalt(storage, origin, "other@example.com"),
    null,
  );
  const restored = await unlockCredential(
    storage,
    origin,
    login,
    password,
    proof,
  );
  assert.equal(restored?.user.id, user.id);
  const wrong = await passwordVerifier("wrong-password", salt);
  await assert.rejects(
    () => unlockCredential(storage, origin, login, "wrong-password", wrong),
    /Incorrect/,
  );
  await assert.rejects(
    () =>
      unlockCredential(storage, origin, login, password, {
        ...proof,
        rounds: 1,
      }),
    /Incorrect/,
  );
  await assert.rejects(
    () =>
      unlockCredential(storage, origin, login, password, {
        ...proof,
        salt: new Array(32).fill(19),
      }),
    /Incorrect/,
  );
  assert(![...values.values()].join("").includes(password));
});
