import { RecycleBinController } from "./recycle-bin";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  ValidationPipe,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { IsString, MaxLength, MinLength } from "class-validator";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { NextFunction, Request, Response } from "express";
import {
  AccessGuard,
  AuthService,
  Permissions,
  Public,
  NativeLogin,
  type AuthRequest,
} from "./auth";
import { settings } from "./config";
import { DatabaseService } from "./database.service";
import { DashboardService } from "./dashboard";
import { ApiErrorFilter } from "./errors";
import { SuppliersController } from "./suppliers";
import { CatalogController } from "./catalog";
import { PurchasesController } from "./purchases";
import { CustomersController } from "./customers";
import { SalesController } from "./sales";
import { TransactionCancellationController } from "./transaction-cancellation";
import { ExpensesController } from "./expenses";
import { ReplacementsController } from "./replacements";
import { apiProxy } from "./api-proxy";
import { ShopSettingsController } from "./shop-settings";
import { UserAccountController } from "./user-account";
import { AccountRecoveryController } from "./account-recovery";
import { AccountMailService } from "./account-mail";
import { shopContext } from "./shop-context";
import { BackupController, BackupService } from "./backups";
import { MobileOfflineController } from "./mobile-offline";

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(120) login!: string;
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}

@Controller("auth")
class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Public()
  @Get("csrf")
  async csrf(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return { data: await this.auth.csrf(req, res) };
  }
  @Public()
  @Post("login")
  async login(
    @Body(
      new ValidationPipe({
        expectedType: LoginDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: LoginDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return { data: await this.auth.login(body.login, body.password, req, res) };
  }
  @Get("me") me(@Req() req: AuthRequest) {
    return { data: req.currentUser };
  }
  @Public()
  @NativeLogin()
  @Post("mobile/login")
  async mobileLogin(
    @Body(
      new ValidationPipe({
        expectedType: LoginDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: LoginDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return {
      data: await this.auth.login(
        body.login,
        body.password,
        req,
        res,
        "bearer",
      ),
    };
  }
  @Post("logout") async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req, res);
    return { data: { loggedOut: true } };
  }
}

@Controller()
class FoundationController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}
  @Public()
  @Get("health")
  async health() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      await this.db.user.count();
    } catch {
      throw new ServiceUnavailableException(
        "Database unavailable or migrations missing. See docs/DEVELOPMENT.md.",
      );
    }
    return { data: { status: "ok", database: "connected", phase: 2 } };
  }
  @Permissions("dashboard.read")
  @Get("dashboard")
  async summary(
    @Req() req: AuthRequest,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return {
      data: await this.dashboard.get(
        req.currentUser!.permissions.includes("finance.read"),
        from,
        to,
      ),
    };
  }
  @Permissions("finance.read")
  @Get("reports/financial-summary")
  async financialSummary(
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return { data: (await this.dashboard.get(true, from, to)).financials };
  }
  @Permissions("access.manage")
  @Get("users")
  async users() {
    return {
      data: await this.db.user.findMany({
        select: {
          id: true,
          name: true,
          login: true,
          active: true,
          version: true,
          email: true,
          roles: { select: { role: { select: { code: true, name: true } } } },
        },
        orderBy: { name: "asc" },
      }),
    };
  }
  @Permissions("access.manage")
  @Get("roles")
  async roles() {
    return {
      data: await this.db.role.findMany({
        select: {
          id: true,
          code: true,
          name: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
        orderBy: { name: "asc" },
      }),
    };
  }
  @Permissions("settings.manage")
  @Get("settings/shop")
  async shop() {
    return {
      data: await this.db.applicationSetting.findUnique({
        where: { key: "shop" },
        select: { value: true, version: true },
      }),
    };
  }
  @Permissions("audit.read")
  @Get("audit-logs")
  async audit() {
    return {
      data: await this.db.auditLog.findMany({
        select: {
          id: true,
          action: true,
          resourceType: true,
          resourceId: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    };
  }
  @Get("modules/:module")
  async module(@Param("module") module: string, @Req() req: AuthRequest) {
    const permission: Record<string, string> = {
      products: "catalog.read",
      purchases: "purchases.manage",
      inventory: "inventory.read",
      sales: "sales.manage",
      replacements: "replacements.intake.customer",
      customers: "parties.customers",
      suppliers: "parties.suppliers",
      accounts: "finance.read",
      reports: "reports.operational",
      settings: "settings.manage",
      "recycle-bin": "parties.suppliers",
      users: "access.manage",
    };
    if (!permission[module]) throw new NotFoundException("Module not found.");
    if (!(
      req.currentUser!.permissions.includes(permission[module]) ||
      (module === "recycle-bin" &&
        req.currentUser!.permissions.includes("transactions.reverse") &&
        ["sales.manage", "purchases.manage"].some((p) =>
          req.currentUser!.permissions.includes(p),
        ))
    ))
      throw new ForbiddenException(
        "You do not have permission to access this module.",
      );
    return {
      data: {
        module,
        status: "FOUNDATION_ONLY",
        message:
          "Navigation and permissions are ready. Business operations are scheduled for the next development phases.",
        rows: [],
      },
    };
  }
}

@Module({
  controllers: [
    MobileOfflineController,
    BackupController,
    AuthController,
    FoundationController,
    ShopSettingsController,
    UserAccountController,
    AccountRecoveryController,
    SuppliersController,
    CatalogController,
    PurchasesController,
    CustomersController,
    SalesController,
    TransactionCancellationController,
    RecycleBinController,
    ExpensesController,
    ReplacementsController,
  ],
  providers: [
    BackupService,
    DatabaseService,
    AuthService,
    AccountMailService,
    DashboardService,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
class AppModule {}

export async function createApp() {
  settings();
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error"],
  });
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(cookieParser());
  const backups = app.get(BackupService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        !req.path.startsWith("/api/v1/auth/") &&
        !req.path.startsWith("/api/v1/backups/")
      )
        backups.changed();
    });
    next();
  });
  app.use(apiProxy(settings().proxySecret));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    (req as AuthRequest).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "private, no-store");
    shopContext.run({}, () => next());
  });
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
