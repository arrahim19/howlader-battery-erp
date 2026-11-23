import { parse } from "dotenv";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const previous = parse(readFileSync(envFile));
const local = path.join(root, ".local/drive-server");
const cluster = path.join(local, "postgres");
mkdirSync(local, { recursive: true, mode: 0o700 });
const configFile = path.join(local, "server.env");
const own = existsSync(configFile)
  ? parse(readFileSync(configFile))
  : {
      DATABASE_URL: `postgresql://howlader_drive:${randomBytes(24).toString("hex")}@127.0.0.1:55433/howlader_drive?schema=public`,
      BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    };
if (!existsSync(configFile))
  writeFileSync(
    configFile,
    Object.entries(own)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n"),
    { mode: 0o600, flag: "wx" },
  );
const url = new URL(own.DATABASE_URL);
const bin =
  previous.PG_BIN_DIR ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/18/bin"
    : "/usr/lib/postgresql/18/bin");
const executable = (name) =>
  path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
function run(file, args, extraEnv = {}, stdio = "inherit") {
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync(file, args, {
    cwd: root,
    env,
    stdio,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(file)} failed; check the local setup logs.`,
    );
}
let identities = [];
if (
  previous.DATABASE_URL &&
  new URL(previous.DATABASE_URL).hostname.endsWith(".neon.tech") &&
  !process.argv.includes("--skip-accounts")
) {
  const source = new pg.Client({
    connectionString: previous.DATABASE_URL_UNPOOLED || previous.DATABASE_URL,
  });
  await source.connect();
  try {
    const shops = await source.query(
      'SELECT id,name,"branchName","schemaName" FROM public."Shop" ORDER BY "createdAt"',
    );
    for (const shop of shops.rows) {
      if (
        shop.schemaName !== "public" &&
        !/^shop_[a-f0-9]{32}$/.test(shop.schemaName)
      )
        throw new Error("Invalid source shop schema.");
      const result = await source.query(
        `SELECT u.id,u.name,u.login,u.email,u."emailVerifiedAt",u."passwordHash",u.active FROM "${shop.schemaName}"."User" u WHERE EXISTS (SELECT 1 FROM "${shop.schemaName}"."UserRole" ur JOIN "${shop.schemaName}"."Role" r ON r.id=ur."roleId" WHERE ur."userId"=u.id AND r.code='OWNER')`,
      );
      identities.push({ shop, users: result.rows });
    }
  } finally {
    await source.end();
  }
}
// Only account identities/password hashes are preserved. No stock, invoices,
// payments, customers or other sample business records are copied.
const identityFile = path.join(local, "account-transfer.json");
if (identities.length)
  writeFileSync(identityFile, JSON.stringify(identities), {
    mode: 0o600,
    flag: "wx",
  });
if (!existsSync(path.join(cluster, "PG_VERSION"))) {
  const pw = path.join(local, "init-password.tmp");
  writeFileSync(pw, decodeURIComponent(url.password), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    run(
      executable("initdb"),
      [
        "-D",
        cluster,
        "-U",
        decodeURIComponent(url.username),
        "--pwfile=" + pw,
        "--auth=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
      ],
      {},
      "ignore",
    );
  } finally {
    unlinkSync(pw);
  }
}
const status = spawnSync(executable("pg_ctl"), ["-D", cluster, "status"], {
  windowsHide: true,
  stdio: "ignore",
});
if (status.status !== 0)
  run(
    executable("pg_ctl"),
    [
      "-D",
      cluster,
      "-l",
      path.join(local, "postgres.log"),
      "-o",
      "-h 127.0.0.1 -p 55433",
      "-w",
      "start",
    ],
    {},
    "ignore",
  );
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const db = new pg.Client({ connectionString: adminUrl.toString() });
await db.connect();
try {
  if (
    !(
      await db.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        "howlader_drive",
      ])
    ).rowCount
  )
    await db.query('CREATE DATABASE "howlader_drive"');
} finally {
  await db.end();
}
const updated = {
  ...previous,
  ...own,
  DATABASE_URL_UNPOOLED: own.DATABASE_URL,
  BACKUP_ENABLED: "true",
  BACKUP_DIRECTORY: path.join(root, ".local/drive-backups"),
  BACKUP_OWNER_USER_ID:
    identities.find((x) => x.shop.schemaName === "public")?.users[0]?.id ||
    previous.BACKUP_OWNER_USER_ID ||
    "",
  GOOGLE_DRIVE_REDIRECT_URI:
    previous.GOOGLE_DRIVE_REDIRECT_URI ||
    "http://localhost:3000/api/v1/backups/google/callback",
  LOCAL_FIRST_SERVER: "true",
};
for (const key of Object.keys(updated))
  if (key.startsWith("NEON_")) delete updated[key];
if (previous.DATABASE_URL !== updated.DATABASE_URL) {
  const retired = path.join(root, ".local/retired-neon");
  mkdirSync(retired, { recursive: true });
  writeFileSync(
    path.join(retired, `env-${Date.now()}.bak`),
    readFileSync(envFile),
    { mode: 0o600, flag: "wx" },
  );
  if (existsSync(path.join(root, ".env.neon")))
    renameSync(
      path.join(root, ".env.neon"),
      path.join(retired, `neon-${Date.now()}.env`),
    );
}
writeFileSync(
  envFile,
  "# PC-hosted ERP; no Neon connection. Keep backup key and OAuth secrets private.\n" +
    Object.entries(updated)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") +
    "\n",
  { mode: 0o600 },
);
run(
  process.execPath,
  [
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--config",
    "packages/database/prisma7.config.ts",
  ],
  updated,
);
run(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "--tsconfig",
    "apps/api/tsconfig.json",
    "scripts/local-first-accounts.ts",
    identityFile,
  ],
  updated,
);
console.log(
  "PC database ready on loopback port 55433. Neon is disconnected. Existing logins preserved when available; no sample business data imported.",
);
