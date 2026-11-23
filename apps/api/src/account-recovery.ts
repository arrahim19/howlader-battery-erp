import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  ValidationPipe,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  AuthService,
  digest,
  hashPassword,
  Public,
  NativePublic,
  verifyPassword,
  type AuthRequest,
} from "./auth";
import { settings } from "./config";
import { DatabaseService } from "./database.service";
import { AccountMailService } from "./account-mail";
import { bindShop } from "./shop-context";

class EmailDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(120)
  email!: string;
}
class LinkEmailDto extends EmailDto {
  @IsString() @MinLength(1) @MaxLength(256) currentPassword!: string;
}
class TokenDto {
  @Matches(/^[a-f0-9]{64}$/) token!: string;
}
class ResetDto extends TokenDto {
  @IsString() @MinLength(6) @MaxLength(256) newPassword!: string;
}
const validation = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
const genericMessage =
  "If this email is linked to an active account, a password reset link will be sent. Check your inbox and spam folder.";

@Controller("auth")
export class AccountRecoveryController {
  private readonly logger = new Logger(AccountRecoveryController.name);
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AccountMailService) private readonly mail: AccountMailService,
  ) {}

  @Get("account")
  async account(@Req() req: AuthRequest) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: req.currentUser!.id },
      select: {
        id: true,
        name: true,
        login: true,
        email: true,
        emailVerifiedAt: true,
        version: true,
      },
    });
    return { data: { ...user, mailConfigured: this.mail.configured() } };
  }

  private requireMail() {
    if (!this.mail.configured())
      throw new ServiceUnavailableException(
        "Email delivery is not configured. Ask the shop administrator to configure SMTP.",
      );
  }

  private async emailTaken(
    tx: Prisma.TransactionClient,
    schemas: string[],
    email: string,
    userId: string,
  ) {
    // Serialize email claims across shops, using the same lock as provisioning.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"account-email:" + email},0))`;
    for (const schema of schemas) {
      if (schema !== "public" && !/^shop_[a-f0-9]{32}$/.test(schema))
        throw new Error("Invalid shop schema.");
      const users = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM ${Prisma.raw(`"${schema}"."User"`)} WHERE ("email"=${email} OR "login"=${email}) AND "id"<>${userId}::uuid LIMIT 1`;
      if (users.length) return true;
    }
    return false;
  }

  private async throttle(req: AuthRequest, action: string, identity?: string) {
    await this.auth.rateLimit(
      digest(`${action}:ip:${req.trustedClientIp ?? req.ip}`),
      30,
    );
    if (identity) await this.auth.rateLimit(digest(`${action}:${identity}`), 5);
  }

  private async issue(
    userId: string,
    email: string,
    purpose: "VERIFY_EMAIL" | "RESET_PASSWORD" | "ACTIVATE_ACCOUNT",
    passwordHash: string,
  ) {
    const raw = randomBytes(32).toString("hex");
    const tokenHash = digest(raw);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
      });
      if (
        !current.active ||
        current.passwordHash !== passwordHash ||
        (purpose !== "VERIFY_EMAIL" && current.email !== email) ||
        (purpose === "ACTIVATE_ACCOUNT" &&
          (current.emailVerifiedAt !== null || current.login !== email))
      )
        throw new ConflictException("Account changed. Please try again.");
      await tx.accountEmailToken.upsert({
        where: { userId_purpose: { userId, purpose } },
        create: {
          userId,
          email,
          purpose,
          tokenHash,
          expiresAt: new Date(Date.now() + 20 * 60000),
        },
        update: {
          email,
          tokenHash,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 20 * 60000),
        },
      });
    });
    const page =
      purpose === "VERIFY_EMAIL"
        ? "verify-email"
        : purpose === "ACTIVATE_ACCOUNT"
          ? "activate-account"
          : "reset-password";
    const url = `${settings().origin}/${page}#token=${raw}`;
    try {
      await this.mail.send(
        email,
        purpose === "ACTIVATE_ACCOUNT"
          ? "Set up your Hawlader Battery account"
          : purpose === "VERIFY_EMAIL"
            ? "Verify your Hawlader Battery email"
            : "Reset your Hawlader Battery password",
        `${purpose === "ACTIVATE_ACCOUNT" ? "Your separate shop account is ready. Verify your email and choose your own password" : purpose === "VERIFY_EMAIL" ? "Confirm this email for your Hawlader Battery account" : "Choose a new password for your Hawlader Battery account"}:\n\n${url}\n\nThis link expires in 20 minutes and can be used once. If you did not request it, ignore this email.`,
      );
    } catch {
      await this.db.accountEmailToken.deleteMany({ where: { tokenHash } });
      // Do not log transport errors: they may contain addresses or credentials.
      this.logger.error(
        "Account email delivery failed. Check SMTP configuration.",
      );
      throw new ServiceUnavailableException(
        "Email could not be sent. Please try again later.",
      );
    }
  }

  @Post("email/request-verification")
  async requestVerification(
    @Body(validation(LinkEmailDto)) body: LinkEmailDto,
    @Req() req: AuthRequest,
  ) {
    this.requireMail();
    await this.throttle(req, "email-link", req.currentUser!.id);
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: req.currentUser!.id },
    });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)))
      throw new BadRequestException("Current password is incorrect.");
    if (user.email === body.email)
      throw new BadRequestException(
        "This email is already verified for your account.",
      );
    const other = await this.db.findAcrossShops((client) =>
      client.user.findFirst({
        where: {
          id: { not: user.id },
          OR: [{ email: body.email }, { login: body.email }],
        },
        select: { id: true },
      }),
    );
    if (other)
      throw new ConflictException(
        "This email is unavailable. Use another email address.",
      );
    await this.issue(user.id, body.email, "VERIFY_EMAIL", user.passwordHash);
    return {
      data: {
        message:
          "Verification email sent. Open the link in your inbox to enable email login and password recovery.",
      },
    };
  }

  @Public()
  @Post("email/verify")
  async verify(
    @Body(validation(TokenDto)) body: TokenDto,
    @Req() req: AuthRequest,
  ) {
    await this.throttle(req, "email-verify");
    const scope = await this.db.findAcrossShops((client) =>
      client.accountEmailToken.findUnique({
        where: { tokenHash: digest(body.token) },
      }),
    );
    if (!scope)
      throw new BadRequestException(
        "Verification link is invalid or expired. Request a new link from Users & Permissions.",
      );
    bindShop(scope.shop);
    const schemas = (await this.db.shopClients()).map(
      (item) => item.shop.schemaName,
    );
    try {
      await this.db.$transaction(async (tx) => {
        const token = await tx.accountEmailToken.findUnique({
          where: { tokenHash: digest(body.token) },
        });
        if (
          !token ||
          token.purpose !== "VERIFY_EMAIL" ||
          token.expiresAt <= new Date()
        )
          throw new BadRequestException(
            "Verification link is invalid or expired. Request a new link from Users & Permissions.",
          );
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${token.userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({
          where: { id: token.userId },
        });
        if (!user.active)
          throw new BadRequestException(
            "Verification link is invalid or expired.",
          );
        const other = await this.emailTaken(tx, schemas, token.email, user.id);
        if (other)
          throw new ConflictException(
            "This email is unavailable. Request verification for another email address.",
          );
        const consumed = await tx.accountEmailToken.deleteMany({
          where: {
            id: token.id,
            tokenHash: token.tokenHash,
            expiresAt: { gt: new Date() },
          },
        });
        if (!consumed.count)
          throw new BadRequestException(
            "Verification link is invalid or expired.",
          );
        const now = new Date();
        await tx.user.update({
          where: { id: user.id },
          data: {
            email: token.email,
            emailVerifiedAt: now,
            version: { increment: 1 },
          },
        });
        await tx.accountEmailToken.deleteMany({ where: { userId: user.id } });
        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.auditLog.create({
          data: {
            action: "AUTH_EMAIL_VERIFIED",
            resourceType: "User",
            resourceId: user.id,
            actorId: user.id,
            requestId: req.requestId,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "This email is unavailable. Use another email address.",
        );
      throw error;
    }
    return {
      data: {
        message:
          "Email verified. You can now sign in with your email and existing password.",
      },
    };
  }

  @Public()
  @NativePublic()
  @Post("mobile/forgot-password")
  async mobileForgot(
    @Body(validation(EmailDto)) body: EmailDto,
    @Req() req: AuthRequest,
  ) {
    return this.forgot(body, req);
  }

  @Public()
  @Post("forgot-password")
  async forgot(
    @Body(validation(EmailDto)) body: EmailDto,
    @Req() req: AuthRequest,
  ) {
    this.requireMail();
    await this.throttle(req, "password-reset", body.email);
    const scope = await this.db.findAcrossShops((client) =>
      client.user.findUnique({
        where: { email: body.email },
      }),
    );
    const user = scope?.record;
    if (user?.active) {
      try {
        bindShop(scope!.shop);
        await this.issue(
          user.id,
          body.email,
          user.emailVerifiedAt ? "RESET_PASSWORD" : "ACTIVATE_ACCOUNT",
          user.passwordHash,
        );
      } catch {
        /* Keep the public response identical for all email addresses. */
      }
    }
    return { data: { message: genericMessage } };
  }

  @Public()
  @Post("activate-account")
  async activate(
    @Body(validation(ResetDto)) body: ResetDto,
    @Req() req: AuthRequest,
  ) {
    await this.throttle(req, "account-activate");
    const scope = await this.db.findAcrossShops((client) =>
      client.accountEmailToken.findUnique({
        where: { tokenHash: digest(body.token) },
      }),
    );
    const token = scope?.record;
    if (
      !token ||
      token.purpose !== "ACTIVATE_ACCOUNT" ||
      token.expiresAt <= new Date()
    )
      throw new BadRequestException(
        "Activation link is invalid or expired. Use Forgot password to request another link.",
      );
    bindShop(scope!.shop);
    const schemas = (await this.db.shopClients()).map(
      (item) => item.shop.schemaName,
    );
    const passwordHash = await hashPassword(body.newPassword);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${token.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: token.userId },
      });
      if (
        !user.active ||
        user.emailVerifiedAt ||
        user.email !== token.email ||
        user.login !== token.email
      )
        throw new BadRequestException("Activation link is invalid or expired.");
      if (await this.emailTaken(tx, schemas, token.email, user.id))
        throw new ConflictException("This email is unavailable.");
      const consumed = await tx.accountEmailToken.deleteMany({
        where: {
          id: token.id,
          tokenHash: token.tokenHash,
          expiresAt: { gt: new Date() },
        },
      });
      if (!consumed.count)
        throw new BadRequestException("Activation link is invalid or expired.");
      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          emailVerifiedAt: now,
          passwordChangedAt: now,
          version: { increment: 1 },
        },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.accountEmailToken.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          action: "AUTH_ACCOUNT_ACTIVATED",
          resourceType: "User",
          resourceId: user.id,
          actorId: user.id,
          requestId: req.requestId,
        },
      });
    });
    return {
      data: {
        message:
          "Account ready. Sign in with your email and the password you just chose.",
      },
    };
  }

  @Public()
  @Post("reset-password")
  async reset(
    @Body(validation(ResetDto)) body: ResetDto,
    @Req() req: AuthRequest,
  ) {
    await this.throttle(req, "password-reset-confirm");
    const scope = await this.db.findAcrossShops((client) =>
      client.accountEmailToken.findUnique({
        where: { tokenHash: digest(body.token) },
      }),
    );
    const token = scope?.record;
    if (
      !token ||
      token.purpose !== "RESET_PASSWORD" ||
      token.expiresAt <= new Date()
    )
      throw new BadRequestException(
        "Reset link is invalid or expired. Request a new link.",
      );
    bindShop(scope!.shop);
    const passwordHash = await hashPassword(body.newPassword);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${token.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: token.userId },
      });
      const consumed = await tx.accountEmailToken.deleteMany({
        where: {
          id: token.id,
          tokenHash: token.tokenHash,
          expiresAt: { gt: new Date() },
        },
      });
      if (
        !consumed.count ||
        !user.active ||
        user.email !== token.email ||
        !user.emailVerifiedAt
      )
        throw new BadRequestException(
          "Reset link is invalid or expired. Request a new link.",
        );
      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          version: { increment: 1 },
        },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.accountEmailToken.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          action: "AUTH_PASSWORD_RESET",
          resourceType: "User",
          resourceId: user.id,
          actorId: user.id,
          requestId: req.requestId,
        },
      });
    });
    return {
      data: { message: "Password reset. Sign in with your new password." },
    };
  }
}
