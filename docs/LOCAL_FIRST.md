# PC server, mobile sync and owner-managed Drive backups

**Superseded:** the user rejected PC-server and paid-hosting operation. Do not install this prototype's startup/desktop shortcuts. They were removed. See [the Apps Script sync foundation and remaining local ERP conversion](../google-apps-script/README.md). This document is retained as a record of the earlier prototype, not the current deployment plan.

This installation no longer uses Neon. The authoritative database is a dedicated PostgreSQL cluster on **127.0.0.1:55433** on the owner's Windows PC. It is separate from the previous development PostgreSQL cluster on port 55432 and the system service on 5432. PostgreSQL is not exposed to phones or the internet.

## What runs where

```text
Owner's desktop workspace ──┐
Owner's Android SQLite ─────┼── authenticated API on PC ── local PostgreSQL
Brother's Android SQLite ───┤                                  │
Other shop's Android ───────┘                                  └── encrypted backups ── owner's Google Drive
```

The desktop shortcut opens a dedicated Microsoft Edge app window, with the same ERP interface. It is not an Electron installer. The Windows sign-in shortcut starts the database, API and web server hidden under the current Windows account. The current launcher uses the development web server; run a production build/deployment before exposing a public service.

Android retains its existing private SQLite cache and durable pending-transaction queue. This change does **not** turn the phone into a standalone PostgreSQL-compatible ERP engine. Confirmed invoices, inventory and accounting are posted by the PC server. Cached reads and supported queued operations work offline; the server confirms them after reconnection. An unsent phone transaction cannot yet be included in a server/Drive backup. First login, new users/products/contacts and some operations require the server. The Android app syncs while open or returning to the foreground; a closed app has no background sync service.

One shop's authenticated identity selects its database schema. Owners of other shops cannot select a shop ID or manage the Drive account. All current and future shop schemas are discovered automatically for backups, including inactive shops. The current transfer preserved existing Betagi and Mirzaganj owner logins/password hashes; no sample business records were imported. A third shop needs its branch name and owner login/email before provisioning through `npm run shop:create`.

## Start and desktop window

```powershell
npm run setup:local-first  # initial setup; re-running does not reset business data
npm run start:local        # database + API + website; keep PC awake
npm run desktop            # dedicated Edge desktop window
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop.ps1
```

The installer adds only two current-user shortcuts: `Howlader Battery House` on the desktop, and `Howlader ERP Server` in Windows Startup. Remove the Startup shortcut to disable automatic sign-in startup. It does not install a Windows system service or change power/firewall settings.

The LAN phone URL is the PC's LAN address at port 3000 (currently `http://192.168.68.79:3000`). A phone at another shop cannot reach a private LAN IP over ordinary mobile data. **Remote access still requires a reachable, authenticated HTTPS deployment/tunnel.** Keep the API port 3001 and PostgreSQL 55433 private. Do not forward the development server directly to the public internet. Once a stable HTTPS address is configured, update `APP_ORIGIN`, mail links, Google redirect URI and the Android login website address together. PC sleep, shutdown or internet loss interrupts remote confirmed operations; pending supported Android transactions are retained.

## Connect the owner's Google Drive

1. At <https://console.cloud.google.com/>, create/select your Google Cloud project and enable **Google Drive API**.
2. Set up Google Auth Platform branding/audience. For an initial test, use External/Testing and add only the owner's Gmail as a test user.
3. Create a **Web application** OAuth client.
4. Add the exact authorized redirect URI: `http://localhost:3000/api/v1/backups/google/callback` for this PC. Use the HTTPS website equivalent when deployed. The callback requires the same signed-in ERP backup administrator.
5. Add these values to the **root `.env`**, not the mobile app, not browser code, and not chat:

   ```dotenv
   GOOGLE_DRIVE_CLIENT_ID="your-web-client-id"
   GOOGLE_DRIVE_CLIENT_SECRET="your-web-client-secret"
   GOOGLE_DRIVE_REDIRECT_URI="http://localhost:3000/api/v1/backups/google/callback"
   ```

6. Restart the API, log in as the original public-shop owner, open **Settings → Automatic backups → Connect Google Drive**, and select the owner's secure Gmail. Brothers do not sign into this Google account.
7. Click **Back up now**. Confirm **Last Drive upload** updates and pending uploads reach zero. Check the `Howlader Battery House - ERP Backups` folder in that Drive.

Only the app-created files are requested with the `drive.file` permission. Google tokens remain encrypted on the PC and never go to Android or the browser. OAuth uses one-time, expiring, administrator-bound state plus PKCE. The administrator is pinned to `BACKUP_OWNER_USER_ID`, not merely an OWNER role (every shop can have its own owner).

Google External/Testing refresh tokens generally expire after seven days when requesting Drive access. For lasting use move the OAuth app to Production and complete any applicable Google requirements. Revocation/expiry/quota/network failures preserve local archives, display pending/error status and retry; reconnect when required. Gmail two-step verification alone does not replace token protection and app permissions.

Official references: [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [Drive permissions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## Automatic backups

- Enabled by `BACKUP_ENABLED=true`. The setup creates a random `BACKUP_ENCRYPTION_KEY` and pins the original owner ID.
- Successful application writes schedule a backup after about ten seconds; closely spaced changes coalesce. Startup also takes a fresh backup. A minute timer retries pending work while the API process is running. This is not guaranteed instant replication.
- `pg_dump` creates compressed, consistent PostgreSQL archives. A complete `all-shops` recovery archive includes the shop registry, logins, settings, stock, invoices, payments, journals, constraints and migration state. Separate per-shop schema archives are also made for administrative recovery.
- Each archive is authenticated with **AES-256-GCM**, a fresh nonce, and a versioned file header. Short-lived plaintext dump files are removed in `finally` after encryption. Archive metadata contains checksums and timestamps, not business records or passwords.
- Files first persist under `.local/drive-backups`. Upload failure retains local files for retry. SHA-256 app properties prevent a lost upload response from creating another copy on retry. Each Drive shop folder is private to the owner's account unless the owner explicitly shares it.
- Backups are versioned and currently retained until the owner deliberately removes them; there is no automatic deletion policy. Monitor both local disk space and Drive quota. No retention process silently deletes pending backups.
- `npm run backup:now` is an operator command. Prefer the Settings button while the API is running; do not run two backup processes simultaneously.

## Recovery key: keep an independent copy

Copy `.local/drive-server/recovery-key.txt` to a secure offline location/USB or password manager. **A Drive archive cannot be decrypted without this key.** A second copy only on the same PC does not protect against PC loss. Do not give this key to other shop accounts or put it beside public/shared backups. Keep the PC Windows account/disk secure too.

`.local/drive-server/server.env` contains local cluster credentials and the backup key. OAuth credentials are encrypted under `.local/drive-backups/google-credentials.enc`. Neither file belongs in source control or an APK. `.env` holds configuration secrets; archived old Neon configuration under `.local/retired-neon` is inactive. The remote Neon project was not deleted or modified; removing the active connection does not cancel a Neon subscription/account.

## Restore without overwriting live data

1. Download a complete `all-shops/*.hbackup` from the owner's Drive, or select a local complete archive.
2. On the recovery server install matching PostgreSQL tools and provide the original `BACKUP_ENCRYPTION_KEY` privately.
3. Create a **new empty database whose name ends in `_restore`**. Set its connection URL in `RESTORE_DATABASE_URL` in the process environment; do not change the live `DATABASE_URL` yet.
4. Run:

   ```powershell
   npm run backup:restore -- 'F:\private\downloaded-archive.hbackup'
   ```

5. The tool authenticates/decrypts the archive before touching tables. It rejects an occupied target and uses one transaction with `pg_restore --exit-on-error`. It never drops the live database. Verify all shop logins, invoices, stock and balances in the recovery database, then switch server connection URLs and restart.

The all-shops archive is the disaster-recovery source. Individual schema dumps can depend on the shared registry/schema history and are for operator-assisted shop recovery, not a one-click overwrite of a live shop. Restoring a database does not automatically restore Google client configuration, the recovery key, hosting DNS, Windows startup shortcuts or app source/build assets; keep those separately.

## Checks

`npm run test:backup` covers authenticated encryption/tampering, wrong-key rejection, owner-only management, OAuth state/PKCE, encrypted token storage, refresh after restart and duplicate-free upload retry using mocked Google responses. A real encrypted local dump was restored into a uniquely named empty verification database and checked across both shop schemas. Live Google account upload cannot be verified until the owner supplies OAuth configuration and grants access.
