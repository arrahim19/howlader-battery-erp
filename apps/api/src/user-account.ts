import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsInt, IsString, MaxLength, Min, MinLength } from "class-validator";
import {
  AuthService,
  digest,
  hashPassword,
  Permissions,
  verifyPassword,
  type AuthRequest,
} from "./auth";
import { DatabaseService } from "./database.service";

class ProfileDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
  @IsInt() @Min(1) version!: number;
}
class PasswordDto {
  @IsString() @MinLength(1) @MaxLength(256) currentPassword!: string;
  @IsString() @MinLength(6) @MaxLength(256) newPassword!: string;
}
const validation = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

@Controller()
export class UserAccountController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Permissions("access.manage")
  @Post("users/:id/profile")
  async profile(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(validation(ProfileDto)) body: ProfileDto,
    @Req() req: AuthRequest,
  ) {
    const data = await this.db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        select: { id: true, name: true },
      });
      if (!user) throw new NotFoundException("User not found.");
      const result = await tx.user.updateMany({
        where: { id, version: body.version },
        data: { name: body.name, version: { increment: 1 } },
      });
      if (result.count !== 1)
        throw new ConflictException(
          "User changed. Reload the page before saving again.",
        );
      await tx.auditLog.create({
        data: {
          action: "USER_PROFILE_UPDATED",
          resourceType: "User",
          resourceId: id,
          actorId: req.currentUser!.id,
          requestId: req.requestId,
          metadata: { previousName: user.name, name: body.name },
        },
      });
      return { id, name: body.name, version: body.version + 1 };
    });
    return { data };
  }

  @Post("auth/change-password")
  async password(
    @Body(validation(PasswordDto)) body: PasswordDto,
    @Req() req: AuthRequest,
  ) {
    await this.auth.rateLimit(
      digest("password-change:" + req.currentUser!.id),
      10,
    );
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: req.currentUser!.id },
    });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)))
      throw new BadRequestException("Current password is incorrect.");
    if (body.currentPassword === body.newPassword)
      throw new BadRequestException("Choose a different new password.");
    const passwordHash = await hashPassword(body.newPassword);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      if (!current.active || current.passwordHash !== user.passwordHash)
        throw new ConflictException(
          "Account changed. Sign in again before changing the password.",
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
          action: "AUTH_PASSWORD_CHANGED",
          resourceType: "User",
          resourceId: user.id,
          actorId: user.id,
          requestId: req.requestId,
        },
      });
    });
    return { data: { changed: true } };
  }
}
