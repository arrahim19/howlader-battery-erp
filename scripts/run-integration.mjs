import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { randomBytes } from "node:crypto";
config({ path: ".env", quiet: true });
const local = new URL(
  process.env.DATABASE_URL ??
    "postgresql://unconfigured@127.0.0.1:55432/hawlader_erp",
);
let connection = process.env.TEST_DATABASE_URL;
if (!connection) {
  if (
    local.hostname !== "127.0.0.1" ||
    local.port !== "55432" ||
    local.pathname !== "/hawlader_erp"
  )
    throw new Error(
      "Set TEST_DATABASE_URL to an isolated database whose name ends in _test. Integration tests never use the business database.",
    );
  const client = new pg.Client({ connectionString: local.toString() });
  await client.connect();
  try {
    const exists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      ["hawlader_erp_test"],
    );
    if (!exists.rowCount)
      await client.query('CREATE DATABASE "hawlader_erp_test"');
  } finally {
    await client.end();
  }
  local.pathname = "/hawlader_erp_test";
  connection = local.toString();
}
if (!new URL(connection).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL database name must end in _test.");
const env = {
  ...process.env,
  DATABASE_URL: connection,
  // Never let Prisma CLI migrations fall back to the business database URL.
  DATABASE_URL_UNPOOLED: connection,
  ERP_INTEGRATION_TEST: "true",
  CSRF_SECRET: randomBytes(48).toString("hex"),
};
function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("node_modules/prisma/build/index.js", [
  "migrate",
  "deploy",
  "--config",
  "packages/database/prisma7.config.ts",
]);
run("node_modules/tsx/dist/cli.mjs", [
  "--tsconfig",
  "apps/api/tsconfig.json",
  "scripts/migrate-shops.ts",
]);
run("node_modules/tsx/dist/cli.mjs", [
  "--tsconfig",
  "apps/api/tsconfig.json",
  "--test",
  "--test-concurrency=1",
  "tests/integration/foundation.test.ts",
  "tests/integration/account.test.ts",
  "tests/integration/mobile-auth.test.ts",
  "tests/integration/shop-isolation.test.ts",
]);
