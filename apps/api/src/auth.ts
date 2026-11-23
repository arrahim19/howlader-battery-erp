import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createRequire } from "node:module";
import type { Request, Response } from "express";
import type { CurrentUser } from "../../../packages/api-client/src";
import { DatabaseService } from "./database.service";
import { settings } from "./config";
import { readSessionIdentity } from "./auth-session";
import { bindShop } from "./shop-context";

// Load the native CommonJS package directly; Vercel's generated import shim
// does not preserve Argon2's hash/verify exports.
const argon2 = createRequire(__filename)("argon2") as typeof import("argon2");

export const Public = () => SetMetadata("public", true);
// Native public auth endpoints do not consume browser cookie credentials.
export const NativePublic = () => SetMetadata("nativePublic", true);
export const NativeLogin = NativePublic;
export const Permissions = (...permissions: string[]) =>
  SetMetadata("permissions", permissions);
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const passwordOptions = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};
export const hashPassword = (password: string) =>
  argon2.hash(password, passwordOptions);
export const verifyPassword = (hash: string, password: string) =>
  argon2.verify(hash, password);
export type AuthRequest = Request & {
  currentUser?: CurrentUser;
  sessionId?: string;
  requestId: string;
  trustedClientIp?: string;
  authTransport?: "cookie" | "bearer";
};

function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class AuthService {
  private readonly config = settings();
  private readonly dummyHash = argon2.hash(randomBytes(32), passwordOptions);
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private tokenForSession(raw: string) {
    return createHmac("sha256", this.config.csrfSecret)
      .update("session-csrf:" + raw)
      .digest("hex");
  }

  async session(req: AuthRequest): Promise<CurrentUser | null> {
    const authorization = req.get("Authorization");
    const bearer = authorization?.match(/^Bearer ([a-f0-9]{64})$/i);
    if (authorization && !bearer) return null;
    const raw: unknown = bearer?.[1] ?? req.cookies?.[this.config.cookieName];
    if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const scope = await this.db.findAcrossShops((client) =>
      readSessionIdentity(client, digest(raw)),
    );
    const session = scope?.record;
    const now = Date.now();
    if (
      !session ||
      session.revokedAt ||
      !session.active ||
      session.expiresAt.getTime() <= now ||
      (!session.deviceSession &&
        session.lastSeenAt.getTime() + this.config.idleMinutes * 60000 <=
          now) ||
      (session.deviceSession && !bearer) ||
      session.createdAt.getTime() < session.passwordChangedAt.getTime()
    )
      return null;
    if (!scope) return null;
    bindShop(scope.shop);
    const updated = await this.db.session.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        expiresAt: { gt: new Date(now) },
      },
      data: {
        lastSeenAt: new Date(now),
        ...(session.deviceSession
          ? { expiresAt: new Date(now + 90 * 86400000) }
          : {}),
      },
    });
    if (updated.count !== 1) return null;
    req.sessionId = session.id;
    req.authTransport = bearer ? "bearer" : "cookie";
    req.currentUser = {
      id: session.userId,
      name: session.name,
      login: session.login,
      roles: session.roles,
      permissions: session.permissions,
      shop: {
        id: scope.shop.id,
        name: scope.shop.name,
        branchName: scope.shop.branchName,
      },
    };
    return req.currentUser;
  }

  async csrf(req: AuthRequest, res: Response) {
    const user = await this.session(req);
    if (user)
      return {
        token: this.tokenForSession(
          req.authTransport === "bearer"
            ? req.get("Authorization")!.slice(7)
            : (req.cookies[this.config.cookieName] as string),
        ),
      };
    const payload =
      randomBytes(24).toString("hex") + "." + (Date.now() + 10 * 60000);
    const token =
      payload +
      "." +
      createHmac("sha256", this.config.csrfSecret)
        .update(payload)
        .digest("hex");
    res.cookie(this.config.preCsrfCookie, token, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60000,
    });
    return { token };
  }

  async checkCsrf(req: AuthRequest, authenticated: boolean) {
    const token = req.get("X-CSRF-Token");
    if (!token) throw new ForbiddenException("CSRF token required.");
    if (authenticated && req.sessionId) {
      const session = await this.db.session.findUnique({
        where: { id: req.sessionId },
      });
      if (!session || !equal(session.csrfTokenHash, digest(token)))
        throw new ForbiddenException("CSRF token invalid.");
      return;
    }
    const cookie: unknown = req.cookies?.[this.config.preCsrfCookie];
    if (typeof cookie !== "string" || !equal(cookie, token))
      throw new ForbiddenException("CSRF token invalid.");
    const [nonce, expires, signature, extra] = token.split(".");
    if (
      !nonce ||
      !expires ||
      !signature ||
      extra ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now()
    )
      throw new ForbiddenException("CSRF token expired.");
    const expected = createHmac("sha256", this.config.csrfSecret)
      .update(nonce + "." + expires)
      .digest("hex");
    if (!equal(signature, expected))
      throw new ForbiddenException("CSRF token invalid.");
  }

  async rateLimit(key: string, limit: number) {
    const rows = await this.db.global.$queryRaw<{ count: number }[]>`
      INSERT INTO "LoginAttempt" ("id", "key", "count", "windowStartedAt", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, 1, NOW(), NOW(), NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "LoginAttempt"."windowStartedAt" < NOW() - INTERVAL '15 minutes' THEN 1 ELSE "LoginAttempt"."count" + 1 END,
        "windowStartedAt" = CASE WHEN "LoginAttempt"."windowStartedAt" < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE "LoginAttempt"."windowStartedAt" END,
        "updatedAt" = NOW()
      RETURNING "count"`;
    if (rows[0].count > limit)
      throw new HttpException(
        "Too many login attempts. Try again in 15 minutes.",
        429,
      );
  }

  async login(
    login: string,
    password: string,
    req: AuthRequest,
    res: Response,
    transport: "cookie" | "bearer" = "cookie",
  ) {
    const normalized = login.trim().toLowerCase();
    const key = (value: string) =>
      createHmac("sha256", this.config.csrfSecret).update(value).digest("hex");
    // A forwarded client IP is trusted only after validating the Worker secret.
    await this.rateLimit(key("ip:" + (req.trustedClientIp ?? req.ip)), 60);
    await this.rateLimit(key("login:" + normalized), 10);
    const scope = await this.db.findAcrossShops((client) =>
      client.user.findFirst({
        where: {
          OR: [
            { login: normalized },
            { email: normalized, emailVerifiedAt: { not: null } },
          ],
        },
      }),
    );
    const user = scope?.record;
    const valid = await argon2.verify(
      user?.passwordHash ?? (await this.dummyHash),
      password,
    );
    if (!user || !valid || !user.active) {
      await this.db.auditLog.create({
        data: {
          action: "AUTH_LOGIN_FAILED",
          resourceType: "Authentication",
          requestId: req.requestId,
        },
      });
      throw new UnauthorizedException("Invalid login or password.");
    }
    if (!scope) throw new UnauthorizedException("Invalid login or password.");
    bindShop(scope.shop);
    const raw = randomBytes(32).toString("hex");
    const csrfToken = this.tokenForSession(raw);
    const now = new Date();
    const expiry = new Date(
      now.getTime() +
        (transport === "bearer"
          ? 90 * 86400000
          : this.config.absoluteHours * 3600000),
    );
    await this.db.$transaction(async (tx) => {
      // Lock and recheck: a simultaneous password reset/deactivation cannot issue a valid session.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      if (!current.active || current.passwordHash !== user.passwordHash)
        throw new UnauthorizedException("Invalid login or password.");
      const previous: unknown =
        transport === "cookie"
          ? req.cookies?.[this.config.cookieName]
          : undefined;
      if (typeof previous === "string")
        await tx.session.updateMany({
          where: { tokenHash: digest(previous), revokedAt: null },
          data: { revokedAt: now },
        });
      await tx.session.create({
        data: {
          userId: user.id,
          deviceSession: transport === "bearer",
          tokenHash: digest(raw),
          csrfTokenHash: digest(csrfToken),
          expiresAt: expiry,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "AUTH_LOGIN",
          resourceType: "User",
          resourceId: user.id,
          requestId: req.requestId,
        },
      });
    });
    if (transport === "bearer")
      return { accessToken: raw, expiresAt: expiry.toISOString() };
    res.cookie(this.config.cookieName, raw, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: "lax",
      path: "/",
      expires: expiry,
    });
    res.clearCookie(this.config.preCsrfCookie, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: "lax",
      path: "/",
    });
    return { csrfToken };
  }

  async logout(req: AuthRequest, res: Response) {
    await this.db.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: req.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.currentUser!.id,
          action: "AUTH_LOGOUT",
          resourceType: "Session",
          resourceId: req.sessionId,
          requestId: req.requestId,
        },
      });
    });
    if (req.authTransport === "bearer") return;
    res.clearCookie(this.config.cookieName, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: "lax",
      path: "/",
    });
  }
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const publicRoute = this.reflector.getAllAndOverride<boolean>("public", [
      context.getHandler(),
      context.getClass(),
    ]);
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const nativeLogin = this.reflector.getAllAndOverride<boolean>(
      "nativePublic",
      [context.getHandler(), context.getClass()],
    );
    const explicitBearer = /^Bearer [a-f0-9]{64}$/i.test(
      req.get("Authorization") ?? "",
    );
    const origin = req.get("Origin");
    if (unsafe && origin && !settings().allowedOrigins.includes(origin))
      throw new ForbiddenException("Request origin not allowed.");
    if (unsafe && !origin && !explicitBearer && !nativeLogin)
      throw new ForbiddenException("Request origin not allowed.");
    if (!publicRoute && !(await this.auth.session(req)))
      throw new UnauthorizedException("Please sign in.");
    // Reauthentication may arrive with an existing session-bound CSRF token.
    if (publicRoute && unsafe && !nativeLogin) await this.auth.session(req);
    if (unsafe && !nativeLogin && req.authTransport !== "bearer")
      await this.auth.checkCsrf(req, Boolean(req.currentUser));
    const permissions =
      this.reflector.getAllAndOverride<string[]>("permissions", [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (
      !permissions.every((permission) =>
        req.currentUser?.permissions.includes(permission),
      )
    )
      throw new ForbiddenException(
        "You do not have permission to access this resource.",
      );
    return true;
  }
}
