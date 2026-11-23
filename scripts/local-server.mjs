import { config } from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
config({ path: path.join(root, ".env"), quiet: true });
const url = new URL(
  process.env.DATABASE_URL || "postgresql://missing@localhost/missing",
);
if (
  process.env.LOCAL_FIRST_SERVER !== "true" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "55433"
)
  throw new Error(
    "Run npm run setup:local-first before starting the PC server.",
  );
const cluster = path.join(root, ".local/drive-server/postgres");
if (!existsSync(path.join(cluster, "PG_VERSION")))
  throw new Error(
    "Local database cluster is missing. Restore it before starting.",
  );
const pgctl = path.join(
  process.env.PG_BIN_DIR || "C:/Program Files/PostgreSQL/18/bin",
  process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
);
const status = spawnSync(pgctl, ["-D", cluster, "status"], {
  windowsHide: true,
  stdio: "ignore",
});
if (status.status !== 0) {
  const start = spawnSync(
    pgctl,
    [
      "-D",
      cluster,
      "-l",
      path.join(root, ".local/drive-server/postgres.log"),
      "-o",
      "-h 127.0.0.1 -p 55433",
      "-w",
      "start",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  if (start.error || start.status !== 0)
    throw new Error(
      "PC database did not start; inspect .local/drive-server/postgres.log.",
    );
}
const children = [
  spawn(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      "watch",
      "--tsconfig",
      "tsconfig.json",
      "src/main.ts",
    ],
    {
      cwd: path.join(root, "apps/api"),
      env: process.env,
      windowsHide: true,
      stdio: "inherit",
    },
  ),
  spawn(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "0.0.0.0",
      "--port",
      "3000",
    ],
    {
      cwd: path.join(root, "apps/web"),
      env: process.env,
      windowsHide: true,
      stdio: "inherit",
    },
  ),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
for (const child of children) {
  child.on("error", stop);
  child.on("exit", stop);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
  "Howlader PC server running. Keep this server and PC online for shop phones. Database is local; Google Drive is the encrypted backup destination.",
);
