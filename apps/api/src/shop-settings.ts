import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Transform } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Prisma } from "@prisma/client";
import { Permissions, type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { nativeCreate } from "./native-create";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

class ShopProfileDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) tagLine?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) tagLine2?: string;
  @Transform(trim) @IsString() @MaxLength(500) address!: string;
  @Transform(trim) @IsString() @MaxLength(50) phone!: string;
  @IsInt() @Min(0) version!: number;
}

@Controller()
export class ShopSettingsController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  // Basic shop identity is used by the sidebar for every signed-in user.
  @Get("shop-profile")
  async profile() {
    const shop = await this.db.applicationSetting.findUnique({
      where: { key: "shop" },
    });
    const value = (shop?.value ?? {}) as Record<string, unknown>;
    return {
      data: Object.fromEntries(
        ["name", "tagLine", "tagLine2", "address", "phone"].map((key) => [
          key,
          typeof value[key] === "string" ? value[key] : "",
        ]),
      ),
    };
  }

  @Permissions("settings.manage")
  @Post("settings/shop")
  async save(
    @Body(
      new ValidationPipe({
        expectedType: ShopProfileDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: ShopProfileDto,
    @Req() req: AuthRequest,
  ) {
    try {
      const data = await nativeCreate(
        this.db,
        req,
        "MOBILE_SHOP_PROFILE",
        body,
        async (tx) => {
          const current = await tx.applicationSetting.findUnique({
            where: { key: "shop" },
          });
          if ((current?.version ?? 0) !== body.version)
            throw new ConflictException(
              "Shop profile changed. Reload the page before saving again.",
            );
          const previous = (current?.value ?? {
            currency: "BDT",
            timezone: "Asia/Dhaka",
          }) as Prisma.JsonObject;
          const value = {
            ...previous,
            name: body.name,
            tagLine: body.tagLine ?? previous.tagLine ?? "",
            tagLine2: body.tagLine2 ?? previous.tagLine2 ?? "",
            address: body.address,
            phone: body.phone,
          };
          if (current) {
            const result = await tx.applicationSetting.updateMany({
              where: { key: "shop", version: body.version },
              data: {
                value,
                version: { increment: 1 },
                changedById: req.currentUser!.id,
              },
            });
            if (!result.count)
              throw new ConflictException(
                "Shop profile changed. Reload the page before saving again.",
              );
          } else {
            await tx.applicationSetting.create({
              data: { key: "shop", value, changedById: req.currentUser!.id },
            });
          }
          await tx.auditLog.create({
            data: {
              action: "SHOP_PROFILE_UPDATED",
              resourceType: "ApplicationSetting",
              resourceId: "shop",
              actorId: req.currentUser!.id,
              requestId: req.requestId!,
              metadata: {
                name: body.name,
                tagLine: value.tagLine,
                tagLine2: value.tagLine2,
                address: body.address,
                phone: body.phone,
              },
            },
          });
          return { value, version: body.version + 1 };
        },
      );
      return { data };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Shop profile changed. Reload the page before saving again.",
        );
      throw error;
    }
  }
}
