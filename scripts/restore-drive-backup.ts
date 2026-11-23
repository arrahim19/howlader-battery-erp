import "reflect-metadata";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import "../apps/api/src/config";
import {
  backupKey,
  decryptBackup,
  postgresTool,
} from "../apps/api/src/backup-files";

async function main() {
  const file = process.argv[2];
  const connection = process.env.RESTORE_DATABASE_URL;
  if (!file || !connection)
    throw new Error(
      "Usage: set RESTORE_DATABASE_URL to a NEW EMPTY database, then npm run backup:restore -- path/to/archive.hbackup. Never restore over a live database.",
    );
  const target = new URL(connection);
  if (!target.pathname.slice(1).endsWith("_restore"))
    throw new Error(
      "Recovery database name must end in _restore. Existing application databases are never overwritten.",
    );
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    const tables = await client.query(
      "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') LIMIT 1",
    );
    if (tables.rowCount)
      throw new Error(
        "Recovery target is not empty. Create a new empty database.",
      );
  } finally {
    await client.end();
  }
  // Authenticate the entire encrypted archive BEFORE passing anything to PostgreSQL.
  const bytes = decryptBackup(await readFile(path.resolve(file)), backupKey());
  const directory = path.resolve(".local/restore-work");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    randomBytes(16).toString("hex") + ".dump",
  );
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await postgresTool(
      "pg_restore",
      [
        "--dbname",
        target.pathname.slice(1),
        "--no-owner",
        "--no-acl",
        "--single-transaction",
        "--exit-on-error",
        temporary,
      ],
      connection,
    );
    console.log(
      "Encrypted backup restored into the separate recovery database. Verify records before switching DATABASE_URL.",
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Restore failed.");
  process.exitCode = 1;
});
