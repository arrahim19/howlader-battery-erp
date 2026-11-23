# Howlader ERP Sync — Google login and owner Drive

The new Google-enrolled device workspace uses local business storage and owner-executed Apps Script. It does not use Neon or an office-PC API. All approved shops upload encrypted snapshots to the primary owner's private Drive. Google quotas/storage limits apply.

## Implemented and remaining

**Design requirement:** Google/local mode must use the existing Chrome ERP components (AppShell, Dashboard, ModulePage, original forms/tables/dialogs) on desktop and phones. The alternate LocalShop prototype was removed. Desktop keeps `/device#/module` navigation and the mobile DOM uses the original Workspace. LocalWorkspaceApi adapts those screen contracts to local storage; unsupported mutations fail without contacting the legacy server. Do not introduce a separate app design.

GoogleLogin.gs exchanges authorization codes using PKCE and the web client secret, then verifies the Google user through Google's HTTPS userinfo endpoint. A supplied email or decoded arbitrary JWT is never trusted. Approved email-to-shop mapping and stable Google subject binding control enrollment. Per-device capabilities expire after 30 days; removing an approved email immediately denies its devices.

Each shop's random AES key is escrowed in the owner's Script Properties. An approved login on another device receives that same key. Neither the office PC nor a manual pairing download is needed for recovery. No Gmail password or web client secret goes into an app.

The new /device workspace uses SQLite/SecureStore on native phones and IndexedDB/Web Crypto on desktop browsers. It calls the local business engine directly, saves upload checkpoints before sending, automatically uploads after commits and retries on foreground/10-second intervals. First restore must succeed before posting. The browser adapter wraps stored login credentials with a nonextractable key; trusted same-origin app code can still access them.

This is a new local workspace, not full parity with every legacy ERP screen. Returns, posted financial reversals, account adjustments, employee role administration, full reporting/settings and invoice printing are not implemented there. Legacy Nest/PostgreSQL screens remain development references. No new installed APK or Windows installer has been released. Native encryption and real Google login/Drive still need device/live verification.

## Update your existing Apps Script

1. Run `node scripts/package-google-login.mjs`. Copy the WHOLE `INSTALL.gs.txt` into the Apps Script editor's Code.gs. This combines the two source files; do not also add a duplicate GoogleLogin.gs. Alternatively deploy Code.gs and GoogleLogin.gs as two separate files, without the generated bundle.
2. Save. `setupHowladerSync` can be rerun safely and preserves existing IDs, keys, backups and revocations. Current shops: Betagi and Mirzaganj. Add the third shop's actual name to HB_SHOPS and rerun setup; do not change existing property IDs.
3. Google Cloud → Google Auth Platform: configure Branding, Audience External and approved Gmail test users. Create a Web application OAuth client with this exact Authorized redirect URI:

```text
https://script.google.com/macros/s/AKfycbxYRbJZkovVHBO2NMidryDW5iFYnNbeibtvXpPcWxzi-v2RDZPHw3kKpjrQX1iV_PM/exec/oauth/callback
```

4. Apps Script → Project Settings → Script properties, save privately:

| Property | Value |
| --- | --- |
| HB_DEPLOYMENT_URL | Existing public deployment URL ending /exec, from deployment.json |
| HB_GOOGLE_CLIENT_ID | Your Web OAuth client ID |
| HB_GOOGLE_CLIENT_SECRET | Its secret, only here |

Never send client secrets, pairing tokens or shop keys through chat, logs or source control.

5. Run `setupHowladerGoogleLogin` as the Drive owner. It maps the owner email to the first shop. Run `showHowladerLoginShops` to print only names and IDs. Extend Script property HB_LOGIN_EMAILS with approved lowercase Gmail-to-shop-ID entries, preserving the owner. Example: `{"owner@example.com":"shop-id-1","brother@example.com":"shop-id-2"}`. Each user must be on both the Google testing audience list and this shop allowlist.
6. Deploy → Manage deployments → Edit → New version → Deploy. Keep the same URL, Execute as Me, Who has access Anyone. Authorize Drive, external request and email scopes if prompted; appsscript.json lists these if you manage the manifest explicitly.
7. Open the native Google login or desktop /device page. Complete Google sign-in in its browser and return. Wait for restore before posting. Verify an isolated test shop across two devices before real use.

The current live deployment in deployment.json has passed public health and unauthenticated-denial checks against the older code, including actual browser GET/POST requests from localhost with ContentService redirects/CORS. Google enrollment is not live until these owner setup/deployment steps are completed. These read-only checks are not authenticated backup verification.

## Automatic multi-device use

Two updated devices can stay signed in to the same shop; ordinary work never requires Switch device or sign-out. Visible/open apps check for remote changes every 10 seconds and immediately when returning to the app/tab. Read-only sync never claims a writer lease. Incoming cloud revisions refresh the original dashboard and list resources without remounting typed forms.

Each save briefly claims a writer lease, refreshes the latest confirmed snapshot, executes the local operation, uploads its durable snapshot and releases automatically. A competing save waits briefly and then uses the refreshed stock, invoice counter and balances. This prevents duplicate invoice numbers or selling the last unit twice. Idle devices hold no lease. The existing Apps Script claim/pull/push/release protocol is unchanged; no Apps Script redeployment is required for this client update. Update both clients; old installed versions still use the retired long-held lease behavior.

New transactions now require a working Drive connection before local posting. A network failure after the local commit preserves the pending write with its original operation ID; retry the same form, rather than creating the transaction again. A lost committed acknowledgement can replay safely even after another device has saved. Pre-existing divergent/offline pending copies remain protected conflicts: never clear storage or overwrite one to dismiss them. Signing out still flushes pending work, but it is not a device-switch requirement. The three-minute lease expiry remains crash recovery only.

The app durably saves writeId, baseRevision, encrypted payload/hash and captured business revision before upload. Retries preserve that exact write. An acknowledgement never marks later local work backed up. The Script Properties head pointer is the commit point; interrupted file uploads do not advance it. History is immutable and retained.

AES-256-GCM uses a random nonce and service/shop-bound additional data. Hash and authentication are checked before restore, followed by local accounting validation. Existing encrypted history without its escrowed key refuses a silent key reset. Keep the owner's Apps Script project secure: its properties contain recovery keys.

POST JSON as text/plain;charset=UTF-8 and follow ContentService redirects. Device-authenticated operations: status, claim, renew, release, pull, push. LoginStart/LoginPoll/LoginAck use a persisted random login proof. Responses are `{ok:true,data:...}` or `{ok:false,error:{code,message}}`. Native HTTP avoids browser CORS restrictions; real deployed browser CORS still needs checking.

8 MiB request limit; snapshot versions are retained. Longer/larger use needs bounded history/incremental sync before reaching these limits. Deployment URL alone cannot read shop data. Legacy PRIVATE-PAIRING files are optional administrative probes, not required for Google onboarding. Never share the Drive folder publicly. For a lost device set HB_REVOKE_DEVICE_ID and run revokeHowladerDevice. Do not delete registry/head/key properties to reset a device.

## Verification

- npm run test:backup: exact Apps Script sources with mocked Google/Drive, identity denial, key recovery, shop isolation, revocation, leases and interrupted/lost-response commits.
- npm run test:mobile: real isolated SQLite accounting, batteries/warranty/replacements, durable checkpoints, retry races, encrypted restore and conflict preservation.
- npx playwright test tests/e2e/local-device.spec.ts --project=desktop: mocked Google enrollment, actual browser IndexedDB/Web Crypto, battery purchase/sale, restart and second-browser restore, with zero ERP API calls. This passed; it does not prove real owner consent or native device behavior.

References: [OAuth web applications](https://developers.google.com/identity/protocols/oauth2/web-server), [Apps Script web apps](https://developers.google.com/apps-script/guides/web), [ContentService redirects](https://developers.google.com/apps-script/guides/content), [quotas](https://developers.google.com/apps-script/guides/services/quotas).
