import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const magic = Buffer.from("HBACKUP1");
export function backupKey(value = process.env.BACKUP_ENCRYPTION_KEY ?? "") {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("BACKUP_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  return Buffer.from(value, "hex");
}
export function encryptBackup(data: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(magic);
  return Buffer.concat([
    magic,
    iv,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function decryptBackup(data: Buffer, key: Buffer) {
  if (data.length < 36 || !data.subarray(0, 8).equals(magic))
    throw new Error("Invalid backup format.");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(8, 20));
  decipher.setAAD(magic);
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    decipher.update(data.subarray(20, -16)),
    decipher.final(),
  ]);
}
export function backupDirectory() {
  const root = process.cwd().endsWith(path.join("apps", "api"))
    ? path.resolve("../..")
    : process.cwd();
  return path.resolve(
    process.env.BACKUP_DIRECTORY ?? path.join(root, ".local/drive-backups"),
  );
}
export async function writePrivate(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function postgresEnvironment(connection: string) {
  const url = new URL(connection);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
    PGCONNECT_TIMEOUT: "20",
  };
}
export async function postgresTool(
  tool: "pg_dump" | "pg_restore",
  args: string[],
  connection: string,
) {
  const binary = path.join(
    process.env.PG_BIN_DIR ??
      (process.platform === "win32"
        ? "C:/Program Files/PostgreSQL/18/bin"
        : "/usr/lib/postgresql/18/bin"),
    tool + (process.platform === "win32" ? ".exe" : ""),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: postgresEnvironment(connection),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timeout = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error(`${tool} could not start. Check PG_BIN_DIR.`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${tool} failed. Check PostgreSQL tools, connection and disk space. ${stderr.replace(/postgres(?:ql)?:\/\/\S+/g, "[connection redacted]")}`,
          ),
        );
    });
  });
}
export async function createEncryptedDump(
  file: string,
  connection: string,
  schema?: string,
) {
  if (schema && schema !== "public" && !/^shop_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid backup shop.");
  const temporary = file + ".dump";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await postgresTool(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file",
        temporary,
        ...(schema ? ["--schema", schema] : []),
      ],
      connection,
    );
    const encrypted = encryptBackup(await readFile(temporary), backupKey());
    await writePrivate(file, encrypted);
    return {
      bytes: encrypted.length,
      sha256: createHash("sha256").update(encrypted).digest("hex"),
    };
  } finally {
    await rm(temporary, { force: true });
  }
}
