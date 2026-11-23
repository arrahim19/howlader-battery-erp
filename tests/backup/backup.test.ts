import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupKey, decryptBackup, encryptBackup, postgresEnvironment } from "../../apps/api/src/backup-files";
import { GoogleDriveBackup } from "../../apps/api/src/google-drive-backup";
import { BackupController, BackupService } from "../../apps/api/src/backups";
import type { DatabaseService } from "../../apps/api/src/database.service";
import type { AuthRequest } from "../../apps/api/src/auth";

test("encrypted backups authenticate the entire archive and reject tampering/wrong keys", () => {
  const key = randomBytes(32);
  const original = Buffer.from("private invoices and customer phone numbers");
  const first = encryptBackup(original, key);
  const second = encryptBackup(original, key);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(original), false);
  assert.deepEqual(decryptBackup(first, key), original);
  assert.throws(() => decryptBackup(first, randomBytes(32)));
  const corrupt = Buffer.from(first); corrupt[25] ^= 1;
  assert.throws(() => decryptBackup(corrupt, key));
  assert.throws(() => decryptBackup(Buffer.from("not a backup"), key));
  assert.throws(() => backupKey("missing"));
});

test("PostgreSQL credentials are passed through environment rather than command arguments", () => {
  const env = postgresEnvironment("postgresql://owner:p%40ss@127.0.0.1:55433/erp?sslmode=disable");
  assert.equal(env.PGPASSWORD, "p@ss"); assert.equal(env.PGPORT, "55433");
  assert.equal(env.PGDATABASE, "erp"); assert.equal(env.PGSSLMODE, "disable");
});

test("only the explicitly configured administrator can manage all-shop backups", async () => {
  const previous = process.env.BACKUP_OWNER_USER_ID;
  process.env.BACKUP_OWNER_USER_ID = "primary-owner";
  try {
    const backups = new BackupService({} as DatabaseService);
    const controller = new BackupController(backups);
    const otherOwner = { currentUser: { id: "other-shop-owner", permissions: ["settings.manage"] } } as unknown as AuthRequest;
    assert.throws(() => controller.connect(otherOwner), /backup administrator/);
    await assert.rejects(controller.run(otherOwner), /backup administrator/);
    assert.doesNotThrow(() => backups.assertOwner({ currentUser: { id: "primary-owner" } } as AuthRequest));
  } finally { if (previous === undefined) delete process.env.BACKUP_OWNER_USER_ID; else process.env.BACKUP_OWNER_USER_ID = previous; }
});

test("Drive OAuth is owner-bound, encrypted at rest, restart-safe and upload retries do not duplicate archives", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "howlader-backup-test-"));
  const keys = ["BACKUP_DIRECTORY", "BACKUP_ENCRYPTION_KEY", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  let refreshes = 0;
  let stored = false;
  const folders = new Map<string, string>();
  const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
  Object.assign(process.env, { BACKUP_DIRECTORY: directory, BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("hex"), GOOGLE_DRIVE_CLIENT_ID: "test-client", GOOGLE_DRIVE_CLIENT_SECRET: "test-secret" });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "refresh_token") refreshes++;
      else assert.ok(params.get("code_verifier"));
      return json({ access_token: "test-access", refresh_token: "private-refresh-token", expires_in: 3600 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-access");
    if (init?.method === "PUT") { uploads++; stored = true; return json({ id: "archive-1" }); }
    if (url.pathname === "/upload/drive/v3/files") return json({}, 200, { Location: "https://www.googleapis.com/resumable-session" });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const key = body.appProperties.hbBackupFolder;
      const id = "folder-" + folders.size; folders.set(key, id); return json({ id });
    }
    const q = url.searchParams.get("q") || "";
    if (q.includes("hbBackupHash")) return json({ files: stored ? [{ id: "archive-1" }] : [] });
    const key = /value='([^']+)'/.exec(q)?.[1] || "";
    return json({ files: folders.has(key) ? [{ id: folders.get(key) }] : [] });
  };
  try {
    const drive = new GoogleDriveBackup();
    const auth = new URL(drive.authorize("owner-a"));
    assert.equal(auth.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.href.includes("test-secret"), false);
    await assert.rejects(drive.callback("code", auth.searchParams.get("state")!, "owner-b"), /expired or invalid/);
    assert.equal(await drive.connected(), false);
    const retry = new URL(drive.authorize("owner-a"));
    await drive.callback("code", retry.searchParams.get("state")!, "owner-a");
    await assert.rejects(drive.callback("code", retry.searchParams.get("state")!, "owner-a"), /expired or invalid/);
    const saved = await readFile(path.join(directory, "google-credentials.enc"));
    assert.equal(saved.includes(Buffer.from("private-refresh-token")), false);
    const restarted = new GoogleDriveBackup();
    assert.equal(await restarted.connected(), true);
    const archive = path.join(directory, "sample.hbackup");
    await writeFile(archive, encryptBackup(Buffer.from("test archive"), backupKey()));
    assert.equal(await restarted.upload(archive, "Shop A", "public", "hash-1"), "archive-1");
    assert.equal(await restarted.upload(archive, "Shop A", "public", "hash-1"), "archive-1");
    assert.equal(uploads, 1); assert.ok(refreshes >= 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("howlader-backup-test-")) throw new Error("Unexpected temporary test path.");
    await rm(resolved, { recursive: true, force: true });
  }
});
