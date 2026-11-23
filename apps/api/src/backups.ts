import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type AuthRequest, Permissions } from "./auth";
import { settings } from "./config";
import { DatabaseService } from "./database.service";
import {
  backupDirectory,
  backupKey,
  createEncryptedDump,
  writePrivate,
} from "./backup-files";
import { GoogleDriveBackup } from "./google-drive-backup";

type Archive = {
  file: string;
  scope: string;
  name: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  driveId?: string;
  uploadedAt?: string;
};
type BackupState = {
  archives: Archive[];
  lastLocalAt?: string;
  lastDriveAt?: string;
  error?: string;
};

@Injectable()
export class BackupService {
  readonly drive = new GoogleDriveBackup();
  private readonly stateFile = path.join(backupDirectory(), "status.json");
  private state: BackupState = { archives: [] };
  private running = false;
  private dirty = true;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private readonly enabled =
    process.env.BACKUP_ENABLED === "true" &&
    process.env.ERP_INTEGRATION_TEST !== "true";
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  async onModuleInit() {
    if (!this.enabled) return;
    backupKey();
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Backup status file is unreadable. Restore it before starting automatic backups.",
        );
    }
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
    this.changed();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }
  changed() {
    if (!this.enabled) return;
    this.dirty = true;
    // A busy shop must not postpone its backup forever; coalesce, do not reset.
    if (!this.debounce) {
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        void this.run();
      }, 10_000);
      this.debounce.unref();
    }
  }
  owner(req: AuthRequest) {
    return Boolean(
      process.env.BACKUP_OWNER_USER_ID &&
      req.currentUser?.id === process.env.BACKUP_OWNER_USER_ID,
    );
  }
  assertOwner(req: AuthRequest) {
    if (!this.owner(req))
      throw new ForbiddenException(
        "Only the configured backup administrator can manage all-shop backups.",
      );
  }
  async status(req: AuthRequest) {
    const administrator = this.owner(req);
    // Public API user identities do not contain schema names. Resolve only the
    // authenticated shop registry entry; never accept a caller-supplied shop ID.
    const shopId = req.currentUser?.shop?.id;
    const shop = shopId
      ? await this.db.global.shop.findUnique({
          where: { id: shopId },
          select: { schemaName: true },
        })
      : null;
    const scope = shop?.schemaName || "unknown";
    const archives = this.state.archives.filter((item) => item.scope === scope);
    const latest = archives.at(-1);
    const uploaded = archives.filter((item) => item.uploadedAt).at(-1);
    return {
      enabled: this.enabled,
      administrator,
      running: this.running,
      localAt: administrator
        ? (this.state.lastLocalAt ?? null)
        : (latest?.createdAt ?? null),
      driveAt: administrator
        ? (this.state.lastDriveAt ?? null)
        : (uploaded?.uploadedAt ?? null),
      pending: administrator
        ? this.state.archives.filter((item) => !item.driveId).length
        : archives.filter((item) => !item.driveId).length,
      error: this.state.error
        ? "Backup needs attention. Local data is retained; the administrator can retry."
        : null,
      ...(administrator
        ? {
            googleConfigured: this.drive.configured,
            driveConnected: await this.drive.connected(),
            redirectUri: this.drive.redirectUri,
            archiveCount: this.state.archives.length,
          }
        : {}),
    };
  }
  private async persist() {
    await writePrivate(this.stateFile, JSON.stringify(this.state, null, 2));
  }
  async run(force = false) {
    if (!this.enabled) {
      if (force)
        throw new ServiceUnavailableException(
          "Enable BACKUP_ENABLED and configure a backup key first.",
        );
      return;
    }
    if (this.running) return;
    this.running = true;
    let localComplete = false;
    try {
      if (this.dirty || force || !this.state.lastLocalAt) {
        this.dirty = false;
        const createdAt = new Date().toISOString();
        const stamp =
          createdAt.replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
        const shops = await this.db.global.shop.findMany({
          select: { schemaName: true, branchName: true, id: true },
          orderBy: { createdAt: "asc" },
        });
        const scopes = [
          { scope: "all-shops", name: "All shops - complete recovery" },
          ...shops.map((shop) => ({
            scope: shop.schemaName,
            name: shop.branchName,
          })),
        ];
        for (const item of scopes) {
          const relative = `${item.scope}/${stamp}.hbackup`;
          const result = await createEncryptedDump(
            path.join(backupDirectory(), relative),
            process.env.DATABASE_URL_UNPOOLED || settings().databaseUrl,
            item.scope === "all-shops" ? undefined : item.scope,
          );
          this.state.archives.push({
            ...item,
            file: relative,
            createdAt,
            ...result,
          });
          await this.persist();
        }
        this.state.lastLocalAt = createdAt;
        await this.persist();
      }
      localComplete = true;
      if (this.drive.configured && (await this.drive.connected())) {
        for (const archive of this.state.archives.filter(
          (item) => !item.driveId,
        )) {
          archive.driveId = await this.drive.upload(
            path.join(backupDirectory(), archive.file),
            archive.name,
            archive.scope,
            archive.sha256,
          );
          archive.uploadedAt = new Date().toISOString();
          this.state.lastDriveAt = archive.uploadedAt;
          await this.persist();
        }
      }
      delete this.state.error;
      await this.persist();
    } catch {
      if (!localComplete) this.dirty = true;
      // Never log database URLs, Google responses, tokens or user records.
      this.state.error =
        "Automatic backup failed; retained archives will retry.";
      await this.persist().catch(() => {});
      if (force) throw new ServiceUnavailableException(this.state.error);
    } finally {
      this.running = false;
    }
  }
}

@Controller("backups")
export class BackupController {
  constructor(@Inject(BackupService) private readonly backups: BackupService) {}
  @Get("status")
  async status(@Req() req: AuthRequest) {
    return { data: await this.backups.status(req) };
  }
  @Permissions("settings.manage")
  @Post("run")
  async run(@Req() req: AuthRequest) {
    this.backups.assertOwner(req);
    await this.backups.run(true);
    return { data: await this.backups.status(req) };
  }
  @Permissions("settings.manage")
  @Post("google/connect")
  connect(@Req() req: AuthRequest) {
    this.backups.assertOwner(req);
    try {
      return {
        data: { url: this.backups.drive.authorize(req.currentUser!.id) },
      };
    } catch {
      throw new ServiceUnavailableException(
        "Configure Google Drive client credentials in .env, then restart the server.",
      );
    }
  }
  @Permissions("settings.manage")
  @Get("google/callback")
  async callback(
    @Req() req: AuthRequest,
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    this.backups.assertOwner(req);
    try {
      await this.backups.drive.callback(code, state, req.currentUser!.id);
      this.backups.changed();
      res.redirect(303, `${settings().origin}/settings?drive=connected`);
    } catch {
      res.redirect(303, `${settings().origin}/settings?drive=failed`);
    }
  }
}
