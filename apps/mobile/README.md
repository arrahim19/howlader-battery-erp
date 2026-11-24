# Hawlader Battery Android app

**1.0.8 login on every app launch:** active workspace access is held in memory only. Fully closing/restarting the app opens the login screen, including on devices that saved an automatic-login token in older releases. Enter the enrolled email/password to unlock offline. The encrypted password verifier and cloud credential remain in Android SecureStore, and SQLite data/pending operations survive closing and logout. The password itself is never stored. Minimizing the app or switching temporarily to another app preserves the current workspace and draft; it does not count as closing the app. An explicit account logout still revokes the cloud session when online. This change requires no API deployment or database migration.

Dashboard's Android Back action locks the workspace before invoking the system exit action, including when Android retains the activity for a warm resume. Back within other workspace pages navigates normally. Back from the login screen exits directly.

**1.0.7 local-first Android:** after one online login and complete initial download, the phone reads and writes its account-scoped SQLite database. Login with the enrolled email/password, dashboard/date filters, stock/search, ledgers, sales, purchase receiving, expenses, customer collections, customer/supplier/product/category creation, replacement intake/status and shop profile work offline. Local stock, balances and cached views update immediately. Reconnect/foreground sync uploads the durable journal and replaces the base snapshot atomically.


**Current source flow:** `/login` uses the website email/login and ERP password form and opens `/workspace/dashboard`. Android local SQLite syncs through the authenticated ERP API to Neon. Google/Drive entry points are retired. Database credentials stay on the API. The production APK targets `https://howlader-battery-erp.vercel.app`.

React Native / Expo SDK 58 app with Expo Router navigation. Its screens import the website's actual React components and responsive stylesheet through an embedded Expo DOM surface, so Chrome mobile view and Android use the same design. The UI is packaged inside the APK and works without loading a remote website. Betagi and Mirzaganj users automatically enter their own shop. No shop ID is accepted from the app to choose a database.

## Included

- Email or existing login, encrypted Android session storage, logout, the shared password recovery form.
- Dashboard, stock search and quantities, paginated sales and purchase records.
- Multi-item sales and purchase receiving, customer/supplier creation, customer collections and ledgers.
- Product creation, expenses, replacement intake and status changes, user listing.
- Shop profile and own name/email/password settings. Password minimum is six characters.
- Branch name on screens, backend permission checks, stable transaction keys on retries.
- Local SQLite database on Android, offline saved pages, and a durable transaction queue with automatic foreground sync.

After an initial online login and download, saved data works offline. Sales, purchases, expenses and customer collections can be saved on the phone and synced later. All existing web modules, including users, settings and recycle bin, share their existing responsive interface. Invoice Print in version 1.0.10 uses Expo Print and Android's system printer / Save as PDF dialog. The DOM bridge exports only the invoice and print CSS, embeds the logo and Bangla fonts for offline rendering, generates A4 PDF, and retains a named cache file (`shop name - reference.pdf`) for the system print adapter. Failures return to the invoice's existing error message; cancellation leaves the transaction untouched. Browser printing continues to use Chrome's print dialog. Physical-device printing still needs verification. The iOS project and Windows desktop installer have not been built.

`src/shared-web` adapts Next links/navigation to Expo Router and web API calls to native actions. The native host keeps bearer credentials in SecureStore and reads/writes the existing SQLite sync engine; bearer tokens never cross into the DOM surface. The postcss configuration compiles the shared Tailwind utilities and embeds the same web fonts for offline use. Invoice artwork is bundled as an asset. Legacy native URLs redirect into the shared workspace rather than exposing the old separate design. Typechecking the combined frontend uses a larger Node stack on Windows and an ignored incremental cache.

The workspace layout owns one persistent DOM surface. Child routes only update its pathname and query props; they do not mount another WebView. This preserves the header, bottom navigation and workspace resource cache during navigation. The navigation test marks the actual shell DOM nodes and verifies their identity after navigating to Inventory and back.

Expo Go print compatibility: Expo Print's generated cache URI can sit outside FileSystem's experience sandbox. Renaming it with `File.move()` fails with `ERR_INVALID_PERMISSION` / missing READ permission. The native print path requests PDF base64 and writes it into the experience's own named cache file, then opens Android's print service. This flow was exercised on the connected Infinix X689B, Android 11/API 30, in Expo Go: PDF rendering and opening the native print dialog succeeded. After changing Metro resolver aliases, restart Expo with `--clear` and reload the project so the DOM uses the native print adapter.

## Local database and sync

Android stores downloaded records and pending transactions in the app's private SQLite database (`hawlader-offline-v1.db`, WAL enabled). The web preview uses IndexedDB instead. Data is partitioned by **website + shop + user**; one account cannot replay another branch's queue. Passwords and bearer tokens are never written to the local database; Android credentials remain in SecureStore.

The initial bootstrap downloads all permitted core lists, customer histories and customer/supplier ledgers in a consistent read-only database transaction. Search, pagination and dashboard date ranges then run locally, including pages never opened individually. The in-memory route cache is invalidated on each local change or cloud snapshot replacement. A lightweight audit version check avoids downloading unchanged business data every 30 seconds. This is a local application replica, not a PostgreSQL server on the phone.

The app syncs on reconnection, on returning to the foreground, every 30 seconds while open, and through **Account menu → Sync & local data → Sync now**. Android does not run a background service when the app is closed. The first setup requires online login and a completed download. Afterwards the enrolled account can log in offline, including after logout/restart, using a salted PBKDF2 verifier held in Android SecureStore; plaintext passwords are not retained. An existing local workspace survives cloud token expiry. Native cloud sessions renew to 90 days on authenticated use; revoked/expired sessions require online sign-in to resume uploads. Browser session limits are unchanged. A successful password change removes the old offline verifier until the next online login.

Each supported write is persisted before the form reports success. A sale/purchase immediately updates local stock, dues, ledgers and totals with a unique **OFF-** reference. This reference is replaced by the server invoice after acknowledgement. Every entry keeps the same body and UUID through retries and restarts. Server transaction/idempotency checks enforce final shared stock and balances; a lost response cannot create a second transaction. Snapshot acknowledgements prevent double-counting a local entry after download.

Stock/validation/permission conflicts remain visible as **Needs review** and pause later queued entries. Retry the unchanged entry after resolving the server issue, or explicitly remove a server-rejected local entry and enter a corrected transaction. Network failures keep the entry pending. Pending entries cannot be silently discarded. Changing account or signing out preserves the queue for its original account only.

Account/security administration (new users, password/email/recovery), supplier edits/deletes, catalog deletes, financial transaction cancellation and recycle-bin restore/permanent-delete still require online validation. These operations are not represented as successful offline writes. Clearing application storage or uninstalling deletes unsynced local data; install the signed update over the existing app and finish the initial download before going offline.

## Run on Android

From the repository root, with Node 26 installed:

```powershell
npm install
npm run dev
# In a second terminal:
npm run dev:mobile
```

Use an Expo Go release compatible with SDK 58 on Android, or an EAS development build. Both the computer and phone must be on the same network. Scan the Metro QR code. If a phone cannot reach Metro, check the computer's network/firewall rules for the local development ports.

On the login screen, enter the **website** address (port 3000 locally), email and ERP password. On a phone, `localhost` means the phone itself. Use the computer's current LAN address, for example `http://192.168.68.79:3000`. The Android emulator can use `http://10.0.2.2:3000`. Copy `.env.example` to `.env.local` to prefill a website address; the field remains editable.

Use `arrahim.dev@gmail.com` for Betagi and `rahim.mugnee@gmail.com` for Mirzaganj after its activation. The app never needs a Gmail App Password. Existing verified accounts and the backend Gmail password recovery service are shared with the website. Recovery/verification emails must point to a website address reachable on the device; localhost links only open on the server computer.

For use from both shops over the internet, deploy the existing website/API to a reachable HTTPS address and keep its environment/database/mail configuration on the server. This repository does not provision hosting automatically.

## Build an installable APK

Latest phone release: `.local/apks/Howlader-Battery-1.0.10-stable.apk`, version code **11**, ARM64, **30,844,455 bytes (29.42 MiB)**. Launcher, round/adaptive icon and splash use the original `public/Logo.webp`; the three generated launcher bitmaps were verified inside the signed APK. Native ExpoPrint is present in the DEX. The release DOM was tested from bundled local files: Print invokes the native action, embeds offline images/fonts, keeps the reference title, displays a native error and retries successfully, and exports one A4 PDF page. All 42 mobile tests, 14 targeted browser tests, lint/typecheck and APK signature/alignment checks passed. Certificate matches 1.0.9, allowing an update with existing local data. SHA-256: `9924910a4356dafcd43771d6822d1f3e391f495135070f82252ead319bff48d3`. Physical-device printer/Save as PDF verification remains pending.

Latest lightweight phone build (25 November 2026): `.local/apks/Howlader-Battery-1.0.9-stable.apk`, ARM64, **30,467,547 bytes (29.06 MiB)**, replacing the 97,142,635-byte universal download. Package `com.hawlader.batteryerp`, version code 10; signature verified and matches the previous app. The packaged DOM UI bundle is byte-for-byte identical to the universal APK. SHA-256: `348ae0abc03bc533b175abb43708b7584451eb07350481d9538987ecc6066652`. Mobile lint, typecheck and all 41 mobile tests passed. No physical-device install was performed.

Current production artifact: `.local/apks/Howlader-Battery-1.0.9-production.apk`, version code 10, ARM64, 32,331,300 bytes. Signature verified and matches the previous app certificate. SHA-256: `2e4b406be8c9eea7d7bfe40d589a2443b456bba72b402fcf244505a8b4eb9f58`. Install over the existing app to preserve local data and offline enrollment. This release fixes login delays and keeps one WebView alive through login/logout/navigation. Pending counts live in the account dropdown; only actual uploads/downloads show Syncing in the header, followed by Synced for three seconds. Unchanged background checks remain quiet, and sales no longer show a saved-on-device banner. The 11 targeted sync/offline credential tests, mobile lint/typecheck, signed APK verification and packaged release DOM bridge checks passed. The packaged UI hash matches the tested release bundle; this APK has not been installed on a physical device.

.local release history — 1.0.7 artifact: `.local/apks/Howlader-Battery-1.0.7-production.apk`, version code **8**, ARM64, **32,322,536 bytes**, built on 23 November 2026. Its signature verifies and matches 1.0.6, so install it as an update without uninstalling. SHA-256: `2b342d1ec19ec6744847a35438a3bdcc55dc669968925b38ba0d488d8a5a8a76`. After updating, sign in online once and finish the first device download to enroll offline password login. The 37 mobile tests, 56 isolated API integration tests, 14 mobile UI tests and actual release DOM bridge test passed. Live production login/bootstrap downloaded 62 views into SQLite; local search/dashboard then made zero network requests and no test business transactions were created. No physical Android device was connected for an on-device test.

The default `npm run build:android` and explicit `npm run build:android:stable` now create an optimized signed **ARM64 phone APK** at `.local/apks/Howlader-Battery-<version>-stable.apk`. The same application ID/signing certificate allows an update over the previous app. ARMv7-only phones need a separate build with `-Architectures armeabi-v7a`. Use `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-local.ps1 -Variant preview` only when a universal APK with emulator support is needed; bundling all four ABIs substantially increases its size. The configured server is preserved; packaging does not deploy a server.

Release configuration explicitly enables R8 and resource shrinking, minifies bundles, and packages the font scripts used by the interface. Native libraries and Hermes bytecode remain uncompressed for direct loading. The local build clears only its owned generated release asset directories before bundling, so obsolete hashed DOM files do not accumulate. Debug symbols and source maps stay outside the APK. The `production` script parameter additionally enforces HTTPS; the `stable` profile retains private LAN HTTP compatibility.

The default is a **local Windows build**. From the repository root:

```powershell
Set-Location 'F:\Web Calculator\Hawlader Battery ERP'
npm run build:android
```

In this mobile workspace, `npm run build:apk` runs the same local build script. It copies current source into `C:\hb-build\erp`, generates the native Android project with Expo Prebuild, and compiles/signs it with the PC's SDK and Gradle. Source remains on F:; generated native files, dependencies and build output use the C: workspace to avoid the low space and long source paths on F:. Unchanged dependencies and native outputs are reused. Daily builds pass `--no-clean` (SDK 58 cleans by default); SDK/React Native version changes regenerate the project. A config plugin caps app object paths at 240 characters for Windows builds. Only files in the tool's own snapshot are synchronized; business `.env` files, credentials and local data are excluded.

The default APK is copied back to `.local\apks\Howlader-Battery-<version>-stable.apk`. Explicit universal preview builds use `.local\apks\Hawlader-Battery-local.apk`. This is a standalone release APK with a bundled JavaScript runtime; Metro and Expo Go are not needed to run the installed APK. The build script disables Expo CLI network requests/telemetry. The first Gradle build still downloads normal Android/Maven dependencies; later builds reuse the local cache.

Verified on this PC on 21 November 2026: `npm run build:android` succeeded. A subsequent build completed in 2 minutes 46 seconds with 505 tasks up to date and produced the identical APK SHA-256. The APK is 98,014,592 bytes; its signature verifies and matches the original app certificate, so it can update that installed app.

Installed on this PC:

- Temurin JDK 17.0.21.1 at `C:\Android\Java\jdk-17.0.21.1+2`.
- Android SDK at `C:\Android\Sdk`: platform-tools, Android platform 37.0, build-tools 37.0.0, NDK 27.1.12297006, CMake 3.30.5.
- Ninja 1.13.2, replacing the SDK CMake bundle's older Ninja for Windows path support; the original binary is retained alongside it.
- `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and Java/Android command paths are configured for this Windows user. Existing terminals may need to be reopened for bare `java`/`adb` commands; the build script reloads these paths automatically.
- Gradle 9.4.1 is provided by the generated project's wrapper and caches under `%USERPROFILE%\.gradle`.

The local build reuses the original APK signing key, exported once from the owner's Expo account. It lives under `C:\Android\signing\hawlader-battery`, restricted to this Windows user. The build reads a DPAPI-protected signing configuration; a private credential export backup is retained in that same restricted folder. No signing credentials are committed or uploaded with source. Preserve this folder privately for future updates. Native signing changes come from `app.config.ts`'s config plugin; do not hand-edit generated Android files.

The local build prefills the public website address from `EXPO_PUBLIC_SERVER_URL`, or `apps/mobile/.env.local` on the source checkout. Keep the ERP server running and connect the phone to the same network for a LAN server such as `http://192.168.68.79:3000`. The login field remains editable. Production use across shops needs a reachable HTTPS website/API.

For faster phone-only builds, an explicit architecture can be supplied:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-local.ps1 -Architectures arm64-v8a
```

For the lightweight 1.0.5 release, use `-Variant stable -Architectures arm64-v8a`.
This targets 64-bit ARM Android phones only. Release code/resource shrinking,
DOM JavaScript minification and JavaScript bundle compression are enabled.
The package ID and private release signing key stay the same so this APK can
update the existing installation. Keep a separate ARMv7 build for 32-bit phones.
The current workspace uses the configured ERP API. For access from different shops,
configure a reachable HTTPS API/website address; a LAN address only works on that LAN.

Built and verified on 22 November 2026: `.local/apks/Howlader-Battery-1.0.5-stable.apk`
is 32,955,886 bytes (31.43 MiB), ARM64 only, versionCode 6. Its APK signature
matches 1.0.4. SHA-256: `0bb9dde62a7c57a6869b3725e2db8e08621150900370e0d7343e93c8fdeb99f0`.
Typecheck, lint, 29 mobile tests, 14 backup tests and the Android release build
passed. Physical-device install/launch was not tested because no phone was connected.

The default includes ARM64, ARMv7, x86 and x86_64. No emulator/system image was installed because testing is on a physical phone through Expo Go. Run `npm run dev:mobile`, scan its QR in a compatible SDK 58 Expo Go app, and keep phone/PC on the same LAN. Expo Go serves JavaScript from the PC; APK compilation runs locally through the separate build command.

### Optional cloud builds

Cloud builds remain available only when wanted:

```powershell
cd apps/mobile
npm run build:apk:cloud
```

This checkout is linked to `@arrahim19/hawlader-battery-erp` (`21e4c3ea-3391-4abf-8503-55b8db156de6`). The earlier cloud APK succeeded on 21 November 2026: [Expo build and download](https://expo.dev/accounts/arrahim19/projects/hawlader-battery-erp/builds/e8e113a2-d794-4048-b9c7-6e34b6365b88). The local command does not use this service or require its login.

The preview APK permits HTTP for private LAN development addresses only. The production profile requires HTTPS and creates the Play Store bundle:

```powershell
npx eas-cli@latest build --platform android --profile production
```

Only the public website address belongs in `EXPO_PUBLIC_SERVER_URL`. Never put SMTP credentials, database URLs, or `API_PROXY_SECRET` in the mobile app or EAS public environment variables. No signing credentials are stored in this repository.

## Verify

On Android, the native SafeAreaView owns system-bar insets. The embedded UI fills that usable container, and quick access is anchored 5px above its bottom. It does not add a second browser safe-area inset. Browser preview retains the website's viewport layout. The mobile UI suite checks three screen heights with three simulated native bottom-inset sizes; physical-device gesture/navigation behavior still needs device validation.

Login and password recovery share a full-width scrolling authentication container. This keeps server connection settings below the form inside Expo DOM's flex root and allows inputs/buttons to remain reachable when the keyboard reduces available height. Login geometry is compared with Chrome mobile at matching viewport sizes.

The DOM boundary preserves user object identity by serialized account contents: native status messages deserialize fresh objects even when the account is unchanged. Re-running account resource effects on those messages caused a request/status feedback loop. Sync status publishes only real changes, and completed background sync refreshes resources without clearing the visible sales form. Test the actual release bridge with `node scripts/test-mobile-dom.mjs <exported-www.bundle-directory>`; it checks bounded reads, real account updates, and draft preservation, without contacting a live server. Expo web preview alone cannot reproduce native serialization.

From the repository root:

```powershell
npm run typecheck --workspace @hawlader/mobile
npm run lint --workspace @hawlader/mobile
npm run build:mobile
npm run test:mobile:e2e
npm run test:mobile
```

`build:mobile` exports the Android JavaScript/assets and embedded DOM bundles; it does not compile native Android code. The Playwright tests exercise the shared UI through Expo's web renderer, compare dashboard dimensions/styles against the Next website at the same mobile viewport, and test cached offline inventory plus precise sale amounts/retry idempotency with mocked API responses. The SQLite tests separately use a real local database. Physical Android testing is still required after installing an APK. API integration tests separately cover bearer session security and shop isolation against PostgreSQL.

Validation on 21 November 2026: workspace typecheck and root lint passed; Expo Doctor passed 20/20 checks; Android bundle export, three mobile screen tests (including disconnected-server sales), and six real SQLite persistence/replay/isolation tests passed. Both the earlier cloud APK and the Windows PC release APK built successfully. The PC APK's v2 signature verifies and its certificate matches the earlier APK; it includes the JavaScript bundle and SQLite native libraries for all four architectures. The LAN Expo Go manifest reports SDK 58 and its Android bundle returned HTTP 200. The earlier isolated PostgreSQL integration run passed 52/53 tests, including all three new native authentication tests and native cross-shop isolation. The existing customer sales history ordering assertion at `tests/integration/foundation.test.ts:3740` still fails. Physical Android testing remains pending.

Run `npx expo-doctor` in this directory for SDK/config health checks. React and React DOM deliberately use 19.3.1 to match the web workspace and avoid duplicate React runtimes in Metro. This patch satisfies React Native 0.88.1's `^19.3.0` peer range; the two packages are excluded from Expo's exact 19.3.0 version recommendation. Other Expo/native dependencies use SDK-compatible versions.

## Authentication

`POST /api/v1/auth/mobile/login` returns an opaque, expiring bearer token. Android stores it using Expo SecureStore, never the password. The server stores only its digest and checks live permissions/shop/session state on every authenticated request. Logout and password changes revoke server sessions. Native anonymous password recovery uses `/auth/mobile/forgot-password`, with the same throttling and generic response as browser recovery. Browser cookie authentication retains its Origin and CSRF requirements. Web preview keeps its token only in memory and loses it on reload.

Expo docs: [SDK 58](https://docs.expo.dev/versions/v58.0.0/), [Android APK builds](https://docs.expo.dev/build-reference/apk/), [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

Shared UI validation (21 November 2026): the Chrome/Expo mobile layout comparison, offline inventory and durable sale retry tests passed (3/3); SQLite tests passed (6/6). Mobile and web typechecks plus targeted lint passed. The release DOM bundle rendered from local files with fonts loaded and zero remote requests. The Windows APK built successfully and its v2 certificate matches the existing release. It contains embedded HTML/CSS/JS, invoice artwork and all four SQLite native libraries. Physical-phone validation remains pending. Metro workers are capped at four after a Windows bundle-writing process crash during the first parallel build.

Expanded audit (21 November 2026): 54 PostgreSQL API integration tests passed against fresh temporary local databases, 10 app-preview tests passed with mocked API responses, and seven real SQLite tests passed. The audit fixed sales-history ordering, native anonymous password recovery, submission during an existing background sync, and misleading rejected/empty-queue messages. Root lint/typecheck and Expo Doctor (20/20) passed. The website's legacy mobile suite returned 40 passed, 21 failed and one skipped; failures include removed buttons/tables and outdated fixtures, and that suite is not certified as passing. Gmail SMTP authentication and localhost/LAN health were checked without sending email. Android print/PDF is still not integrated and physical-phone validation remains pending.

## Neon mobile release 1.0.6

Built on 22 November 2026: `.local/apks/Howlader-Battery-1.0.6-production.apk`, versionCode 7, ARM64 only, 32,274,996 bytes. Its signature matches 1.0.5, and the packaged URL is `https://howlader-battery-erp.vercel.app`. Typecheck, lint, three targeted mobile browser tests and the actual release DOM bridge test passed. No physical-device install was performed. The Vercel API was deployed and verified: mobile password login, bearer authentication, Neon download through the actual SQLite sync engine, persisted cached records, offline reads and logout revocation passed. Live verification created no business transactions.
