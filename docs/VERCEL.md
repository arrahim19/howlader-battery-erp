# Vercel deployment

Current production address: `https://howlader-battery-erp.vercel.app`. The Android 1.0.6 production APK uses this address. Current source was deployed on 22 November 2026. Live mobile password login, expiring bearer credentials, authenticated Neon reads, the actual SQLite sync engine, durable cached records, offline cached reads and logout revocation passed. Empty JSON requests to mobile login/recovery return validation error 400. Business transactions were not created by the live check; queued writes, retry/idempotency and conflicts are covered by isolated integration/SQLite tests. Google Drive is disabled by default.

The root `vercel.json` deploys two Vercel Services together: the Next.js frontend
in `apps/web` and the NestJS API in `apps/api`. Requests under `/api/` reach the
API with their original path, including `/api/v1`; all other paths reach the
frontend. Both use the same public domain for session cookies and CSRF checks.
The API uses Vercel's NestJS runtime, not a container.
The root address redirects to `/dashboard` at the deployment level.
Functions run in Singapore (`sin1`), matching the Neon database region, to avoid
cross-continent latency on each query. This setting takes effect on deployment;
static frontend assets continue to use Vercel's global CDN.

## Import from GitHub

1. Import this repository's latest `main` commit as a new Vercel project.
2. Keep **Root Directory** at `./` and **Application Preset** at **Services**.
   Import the whole project rather than either individual application.
3. Confirm that only `api` and `web` are listed. If the import still lists the
   deleted container service, leave the import page and start a fresh import
   from the repository after the latest commit is available.
4. Use Node.js **26.x LTS**. The root and both service manifests pin `engines.node` to `26.x`, overriding an older dashboard selection on the next deployment. Build and install commands are supplied by `vercel.json`;
   leave dashboard command overrides unset.
5. Add the environment variables below before deploying.

## Environment variables

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Production PostgreSQL connection URL; for Neon use the pooled URL with SSL. |
| `CSRF_SECRET` | A stable random secret containing at least 32 characters. |
| `APP_ORIGIN` | The exact HTTPS address used to open the ERP, for example `https://howlader-battery-erp.vercel.app`. Use the domain Vercel actually assigns. |

Generate a new secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the same `CSRF_SECRET` across redeployments to preserve existing sessions.
The configuration supplies `NODE_OPTIONS=--experimental-require-module` for the
runtime. NestJS 12 is ESM-only, while this API compiles to CommonJS; Vercel
disables Node's `require(esm)` support by default, so this flag is required.
If `NODE_OPTIONS` is also set in the dashboard, include this flag in that value.
Do not add the obsolete `API_PROXY_SECRET` or `INTERNAL_API_URL` settings to this
deployment. The browser calls the API directly through Vercel's same-domain
service routing. Leave `API_HOST` unset. Vercel supplies `NODE_ENV=production`.
Never prefix database credentials or secrets with `NEXT_PUBLIC_`.

Set production variables for Production. Preview environments need their own
database and `APP_ORIGIN` matching the preview address; authenticated writes
reject other origins. Update `APP_ORIGIN` and redeploy if the public domain
changes.

## Prepare the database

Installation generates Prisma Client. Builds deliberately do not apply database
migrations or create users. Before using the deployed API, run these commands
from the repository root in an operator terminal configured for the production
database:

```powershell
$env:NODE_ENV = 'production'
$env:APP_ORIGIN = 'https://YOUR-ACTUAL-DOMAIN'
# Supply DATABASE_URL and CSRF_SECRET securely in this terminal.
# For Neon, also supply DATABASE_URL_UNPOOLED using its direct connection URL.
npm run db:migrate
# For a new database, also supply ERP_ADMIN_PASSWORD securely (12+ characters).
npm run db:admin
```

These commands target the database supplied in the terminal; check the target
before running them. Existing owner credentials are preserved by `db:admin`.
Avoid running production setup from a terminal used by local development servers.

## Verify deployment

- `/login` loads the frontend.
- `/api/v1/health` reports a connected database with migrations applied.
- Sign in, refresh `/dashboard`, and sign out to check cookies and CSRF handling.

Local development continues to use `npm run dev`; the Next.js API rewrite is
enabled locally and disabled on Vercel, where service routing handles it.

References: [Vercel Services](https://vercel.com/docs/services),
[service configuration](https://vercel.com/docs/services/config-reference),
[service routing](https://vercel.com/docs/services/routing), and
[NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs).
