import { config } from "dotenv";
import path from "node:path";
// Works with both tsx source execution and the compiled monorepo output.
config({
  path: path.resolve(
    process.cwd(),
    process.cwd().endsWith(path.join("apps", "api")) ? "../../.env" : ".env",
  ),
  quiet: true,
});
export function settings() {
  const production = process.env.NODE_ENV === "production";
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  // PostgreSQL/Neon credentials stay in the API; phones use its public URL.
  const csrfSecret = process.env.CSRF_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !csrfSecret ||
    csrfSecret.length < 32 ||
    csrfSecret.startsWith("REPLACE_")
  )
    throw new Error(
      "Set CSRF_SECRET with npm run setup (32+ random characters).",
    );
  if (!databaseUrl || databaseUrl.includes("CHANGE_ME"))
    throw new Error("Configure DATABASE_URL in .env; see docs/DEVELOPMENT.md.");
  const parsed = new URL(origin);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("APP_ORIGIN must be an HTTP(S) origin.");
  if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  if (production && parsed.protocol !== "https:")
    throw new Error("Production APP_ORIGIN must use HTTPS.");
  const allowedOrigins = [parsed.origin];
  if (!production) {
    for (const value of (process.env.APP_DEV_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const extra = new URL(value);
      if (!["http:", "https:"].includes(extra.protocol))
        throw new Error(
          "APP_DEV_ORIGINS must contain comma-separated HTTP(S) origins.",
        );
      allowedOrigins.push(extra.origin);
    }
  }
  const idleMinutes = Number(process.env.SESSION_IDLE_MINUTES ?? 60);
  const absoluteHours = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12);
  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);
  const host = process.env.API_HOST ?? "127.0.0.1";
  const proxySecret = process.env.API_PROXY_SECRET;
  if (!["127.0.0.1", "0.0.0.0"].includes(host))
    throw new Error("API_HOST must be 127.0.0.1 or 0.0.0.0.");
  if (proxySecret && proxySecret.length < 32)
    throw new Error("API_PROXY_SECRET must contain at least 32 characters.");
  if (production && host === "0.0.0.0" && !proxySecret)
    throw new Error("A public API requires API_PROXY_SECRET.");
  if (
    ![idleMinutes, absoluteHours, port].every(Number.isInteger) ||
    idleMinutes < 1 ||
    absoluteHours < 1 ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid port/session environment settings.");
  return {
    production,
    origin: parsed.origin,
    allowedOrigins,
    csrfSecret,
    databaseUrl,
    idleMinutes,
    absoluteHours,
    port,
    host,
    proxySecret,
    cookieName: production ? "__Host-hb_session" : "hb_session",
    preCsrfCookie: production ? "__Host-hb_pre_csrf" : "hb_pre_csrf",
  };
}
