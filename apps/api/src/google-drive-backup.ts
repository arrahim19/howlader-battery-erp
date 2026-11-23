import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  backupDirectory,
  backupKey,
  decryptBackup,
  encryptBackup,
  writePrivate,
} from "./backup-files";

type Credentials = { refreshToken: string; folderId?: string };
export class GoogleDriveBackup {
  private accessToken = "";
  private expiresAt = 0;
  private state?: {
    value: string;
    verifier: string;
    expires: number;
    userId: string;
  };
  private readonly file = path.join(
    backupDirectory(),
    "google-credentials.enc",
  );
  get configured() {
    return Boolean(
      process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    );
  }
  get redirectUri() {
    return (
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      `${process.env.APP_ORIGIN || "http://localhost:3000"}/api/v1/backups/google/callback`
    );
  }
  async credentials(): Promise<Credentials | null> {
    try {
      return JSON.parse(
        decryptBackup(await readFile(this.file), backupKey()).toString(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        "Drive credentials cannot be decrypted; check the backup key.",
      );
    }
  }
  async connected() {
    return Boolean((await this.credentials())?.refreshToken);
  }
  authorize(userId: string) {
    if (!this.configured)
      throw new Error(
        "Configure GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET first.",
      );
    const verifier = randomBytes(32).toString("base64url");
    this.state = {
      value: randomBytes(32).toString("base64url"),
      verifier,
      expires: Date.now() + 10 * 60_000,
      userId,
    };
    const query = new URLSearchParams({
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent select_account",
      state: this.state.value,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }
  async callback(code: string, state: string, userId: string) {
    const pending = this.state;
    this.state = undefined;
    if (
      !pending ||
      !code ||
      pending.value !== state ||
      pending.userId !== userId ||
      pending.expires < Date.now()
    )
      throw new Error(
        "Google connection expired or invalid. Connect again from Settings.",
      );
    const result = await this.token({
      code,
      code_verifier: pending.verifier,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });
    if (!result.refresh_token)
      throw new Error(
        "Google did not grant offline access. Connect again with consent.",
      );
    this.accessToken = "";
    await this.save({ refreshToken: result.refresh_token });
    // Confirm that the credential can actually access Drive before reporting connected.
    await this.folder("Howlader Battery House - ERP Backups", "erp-root");
  }
  private async save(value: Credentials) {
    await writePrivate(
      this.file,
      encryptBackup(Buffer.from(JSON.stringify(value)), backupKey()),
    );
  }
  private async token(values: Record<string, string>) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        ...values,
        client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
      }),
    });
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !data.access_token)
      throw new Error(
        "Google authorization failed. Reconnect Google Drive in Settings.",
      );
    return data;
  }
  private async bearer() {
    if (this.accessToken && this.expiresAt > Date.now() + 60_000)
      return this.accessToken;
    const stored = await this.credentials();
    if (!stored)
      throw new Error(
        "Google Drive is not connected. Local backups are retained.",
      );
    const token = await this.token({
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    });
    this.accessToken = token.access_token!;
    this.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    if (token.refresh_token)
      await this.save({ ...stored, refreshToken: token.refresh_token });
    return this.accessToken;
  }
  private async request(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(120_000),
      headers: {
        ...init.headers,
        Authorization: `Bearer ${await this.bearer()}`,
      },
    });
    if (!response.ok) {
      if (response.status === 401) this.accessToken = "";
      throw new Error(
        `Google Drive request failed (${response.status}); local backups will retry.`,
      );
    }
    return response;
  }
  async folder(name: string, key: string, parent?: string): Promise<string> {
    const q = `trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='hbBackupFolder' and value='${key}' }${parent ? ` and '${parent}' in parents` : ""}`;
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "100" })}`,
    );
    const found = (await response.json()) as { files: { id: string }[] };
    if (found.files[0]) return found.files[0].id;
    const created = await this.request(
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          appProperties: { hbBackupFolder: key },
          ...(parent ? { parents: [parent] } : {}),
        }),
      },
    );
    return ((await created.json()) as { id: string }).id;
  }
  async upload(
    file: string,
    folderName: string,
    scope: string,
    digest: string,
  ) {
    const root = await this.folder(
      "Howlader Battery House - ERP Backups",
      "erp-root",
    );
    const parent = await this.folder(folderName, scope, root);
    const q = `trashed = false and '${parent}' in parents and appProperties has { key='hbBackupHash' and value='${digest}' }`;
    const lookup = await this.request(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`,
    );
    const found = (await lookup.json()) as { files: { id: string }[] };
    if (found.files[0]) return found.files[0].id;
    const bytes = await readFile(file);
    const start = await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "application/octet-stream",
          "X-Upload-Content-Length": String(bytes.length),
        },
        body: JSON.stringify({
          name: path.basename(file),
          parents: [parent],
          appProperties: { hbBackupHash: digest, hbBackupScope: scope },
        }),
      },
    );
    const location = start.headers.get("Location");
    if (!location || new URL(location).origin !== "https://www.googleapis.com")
      throw new Error("Invalid Google upload location.");
    const result = await this.request(location, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    });
    return ((await result.json()) as { id: string }).id;
  }
}
