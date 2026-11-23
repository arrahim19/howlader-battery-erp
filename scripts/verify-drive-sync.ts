import { config } from "dotenv";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DriveSyncError,
  DriveSyncTransport,
  type DrivePairing,
} from "../packages/drive-sync/src";

const root = path.resolve(__dirname, "..");
config({ path: path.join(root, ".env"), quiet: true });
async function main() {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      'Download your private desktop pairing JSON from your Drive, then run: npm run drive:verify -- "full/path/to/private-pairing.json". Never paste the token into chat.',
    );
  const resolved = path.resolve(file);
  if (
    !(await stat(resolved)).isFile() ||
    (await stat(resolved)).size > 64 * 1024
  )
    throw new Error(
      "Select the small private pairing JSON file, not a database or backup archive.",
    );
  const deployment = JSON.parse(
    await readFile(
      path.join(root, "google-apps-script/deployment.json"),
      "utf8",
    ),
  ) as { url: string };
  let pairing: DrivePairing;
  try {
    pairing = JSON.parse(
      (await readFile(resolved, "utf8")).replace(/^\uFEFF/, ""),
    );
  } catch {
    throw new Error(
      "The pairing file is not valid JSON. Download the original file from your private Drive folder.",
    );
  }
  if (!pairing || typeof pairing !== "object")
    throw new Error("Invalid device pairing file.");
  const transport = new DriveSyncTransport(
    process.env.GOOGLE_APPS_SCRIPT_SYNC_URL || deployment.url,
    pairing,
  );
  // Read-only: do not claim a writer lease, upload a dummy database, or modify
  // any real shop data merely to verify this connection.
  const status = await transport.status();
  if (
    status.shop.id !== pairing.shopId ||
    !Number.isSafeInteger(status.head.revision) ||
    status.head.revision < 0
  )
    throw new Error("The response does not match this device's shop pairing.");
  const proof = {
    verifiedAt: new Date().toISOString(),
    endpoint: deployment.url,
    authenticated: true,
    shop: status.shop.name,
    device: pairing.deviceName,
    committedRevision: status.head.revision,
    note: "Read-only protocol verification; local ERP integration is not implied.",
  };
  const local = path.join(root, ".local/drive-sync");
  await mkdir(local, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(local, "verification.json"),
    JSON.stringify(proof, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    `Google Drive sync verified for ${status.shop.name} (${pairing.deviceName}); committed revision ${status.head.revision}.`,
  );
  console.log(
    "No writer lease was claimed, no financial data was read or changed, and no credential was printed.",
  );
}
main().catch((error: unknown) => {
  if (error instanceof DriveSyncError)
    console.error(`${error.code}: ${error.message}`);
  else if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    console.error(
      "Pairing/configuration file not found. Check the local file path.",
    );
  else
    console.error(
      error instanceof Error
        ? error.message
        : "Drive sync verification failed.",
    );
  process.exitCode = 1;
});
