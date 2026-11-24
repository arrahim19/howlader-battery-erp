import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Param,
  ParseUUIDPipe,
  NotFoundException,
  Query,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Prisma, TrackingKind } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Permissions, type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { nativeCreate } from "./native-create";
import { productCategoryCodes } from "./product-categories";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

class CreateProductTypeDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsEnum(TrackingKind) trackingKind!: TrackingKind;
}
class DeleteProductTypeDto {
  @Equals(true) confirmed!: boolean;
}
class CreateCategoryDto {
  @IsUUID() typeId!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(160) name!: string;
}
class DeleteCategoryDto {
  @IsUUID() typeId!: string;
  @Equals(true) confirmed!: boolean;
}
class CatalogQueryDto {
  @IsOptional() @IsUUID() typeId?: string;
  @IsIn(["all", "active", "inactive"]) status = "active";
}
class ProductsQueryDto extends CatalogQueryDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.split(",") : value,
  )
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  brandIds?: string[];
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
}
class CreateProductDto {
  @IsUUID() typeId!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(30) unit!: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) model?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) brand?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) category?: string;
  @Matches(/^\d{1,18}(?:\.\d{1,2})?$/) defaultSellingPrice = "0.00";
  @Matches(/^\d{1,15}(?:\.\d{1,3})?$/) lowStockThreshold = "0";
  @IsInt() @Min(0) @Max(600) warrantyMonths = 0;
  @IsOptional() @Matches(/^\d{1,8}(?:\.\d{1,2})?$/) capacityAh?: string;
  @IsOptional() @Matches(/^\d{1,8}(?:\.\d{1,2})?$/) voltage?: string;
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specifications?: string;
}
class UpdateProductDto {
  @IsInt() @Min(1) version!: number;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @Transform(trim) @IsString() @MaxLength(160) model!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(30) unit!: string;
  @Matches(/^\d{1,18}(?:\.\d{1,2})?$/) defaultSellingPrice!: string;
  @IsInt() @Min(0) @Max(600) warrantyMonths!: number;
}
const validation = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
const activeWhere = (status: string): Prisma.ProductWhereInput =>
  status === "all" ? {} : { active: status === "active" };
const productFields = {
  id: true,
  version: true,
  name: true,
  model: true,
  unit: true,
  active: true,
  defaultSellingPrice: true,
  lowStockThreshold: true,
  batches: {
    where: { origin: "PURCHASE" },
    orderBy: [{ acquiredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { unitCost: true },
  },
  type: { select: { id: true, name: true, trackingKind: true } },
  brand: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  batteryDetail: {
    select: {
      capacityAh: true,
      voltage: true,
      defaultWarrantyMonths: true,
    },
  },
  partsDetail: {
    select: { specifications: true, defaultWarrantyMonths: true },
  },
} satisfies Prisma.ProductSelect;
type ProductRow = Prisma.ProductGetPayload<{ select: typeof productFields }>;
function productDto(row: ProductRow) {
  const { batteryDetail, partsDetail, batches, ...product } = row;
  return {
    ...product,
    defaultSellingPrice: row.defaultSellingPrice.toFixed(2),
    latestPurchasePrice: batches[0]?.unitCost.toFixed(2) ?? null,
    lowStockThreshold: row.lowStockThreshold.toString(),
    warrantyMonths:
      batteryDetail?.defaultWarrantyMonths ??
      partsDetail?.defaultWarrantyMonths ??
      0,
    capacityAh: batteryDetail?.capacityAh?.toString() ?? null,
    voltage: batteryDetail?.voltage?.toString() ?? null,
    specifications: partsDetail?.specifications ?? null,
    stock: {
      total: "0",
      available: "0",
      replaceable: "0",
      reserved: "0",
      sentToCompany: "0",
    },
  };
}

@Controller()
@Permissions("catalog.read")
export class CatalogController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get("catalog")
  async options(@Query(validation(CatalogQueryDto)) query: CatalogQueryDto) {
    const where = activeWhere(query.status);
    const [types, brands, categories, groups] = await Promise.all([
      this.db.productType.findMany({
        where: { active: true, code: { in: productCategoryCodes } },
        select: {
          id: true,
          code: true,
          name: true,
          trackingKind: true,
          _count: { select: { products: { where } } },
        },
        orderBy: { name: "asc" },
      }),
      this.db.brand.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      this.db.category.findMany({
        where: { active: true },
        select: { id: true, name: true, types: { select: { typeId: true } } },
        orderBy: { name: "asc" },
      }),
      this.db.product.groupBy({
        by: ["typeId", "brandId", "categoryId"],
        where,
        _count: { _all: true },
      }),
    ]);
    const scoped = groups.filter(
      (group) => !query.typeId || group.typeId === query.typeId,
    );
    const categoryCountsByType = new Map<string, Record<string, number>>();
    for (const group of groups) {
      if (!group.categoryId) continue;
      const counts = categoryCountsByType.get(group.categoryId) ?? {};
      counts[group.typeId] = (counts[group.typeId] ?? 0) + group._count._all;
      categoryCountsByType.set(group.categoryId, counts);
    }
    const counts = (field: "brandId" | "categoryId", id: string) =>
      scoped
        .filter((group) => group[field] === id)
        .reduce((sum, group) => sum + group._count._all, 0);
    return {
      data: {
        types: types
          .sort(
            (a, b) =>
              productCategoryCodes.indexOf(a.code) -
              productCategoryCodes.indexOf(b.code),
          )
          .map(({ _count, id, name, trackingKind }) => ({
            id,
            name,
            trackingKind,
            productCount: _count.products,
          })),
        brands: brands.map((brand) => ({
          ...brand,
          productCount: counts("brandId", brand.id),
        })),
        categories: categories.map(({ types, ...category }) => ({
          ...category,
          typeIds: types.map((link) => link.typeId),
          productCountsByType: {
            ...Object.fromEntries(types.map((link) => [link.typeId, 0])),
            ...categoryCountsByType.get(category.id),
          },
          productCount: counts("categoryId", category.id),
        })),
        totalProducts: groups.reduce(
          (sum, group) => sum + group._count._all,
          0,
        ),
      },
    };
  }

  @Post("product-types")
  @Permissions("catalog.write")
  async createType(
    @Body(validation(CreateProductTypeDto)) body: CreateProductTypeDto,
  ) {
    void body;
    throw new ConflictException(
      "Product categories are fixed: Battery, Parts, Easy Bike & Rickshaw.",
    );
  }

  @Get("products")
  async list(@Query(validation(ProductsQueryDto)) query: ProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      ...activeWhere(query.status),
      ...(query.typeId ? { typeId: query.typeId } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.brandIds ? { brandId: { in: query.brandIds } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { model: { contains: query.q, mode: "insensitive" } },
              { brand: { name: { contains: query.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.product.findMany({
        where,
        select: productFields,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.product.count({ where }),
    ]);
    const ids = items.map((item) => item.id);
    const [units, parts] = ids.length
      ? await Promise.all([
          this.db.batteryUnit.groupBy({
            by: [
              "productId",
              "ownership",
              "condition",
              "custody",
              "commercialState",
            ],
            where: { productId: { in: ids } },
            _count: { _all: true },
          }),
          this.db.$queryRaw<
            { productId: string; total: string; available: string }[]
          >`
        SELECT b."productId", COALESCE(SUM(i.quantity),0)::text AS total,
        COALESCE(SUM(i.quantity) FILTER (WHERE i.location='SHOP' AND i.bucket='AVAILABLE'),0)::text AS available
        FROM "InventoryBalance" i JOIN "StockBatch" b ON b.id=i."batchId"
        WHERE b."productId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) GROUP BY b."productId"`,
        ])
      : [[], []];
    return {
      data: {
        items: items.map((item) => {
          const stock = productDto(item);
          const groups = units.filter((group) => group.productId === item.id);
          const count = (
            predicate: (group: (typeof groups)[number]) => boolean,
          ) =>
            String(
              groups
                .filter(predicate)
                .reduce((sum, group) => sum + group._count._all, 0),
            );
          const quantity = parts.find((part) => part.productId === item.id);
          stock.stock = {
            total:
              (quantity
                ? new Prisma.Decimal(quantity.total).toString()
                : null) ??
              count(
                (g) =>
                  g.ownership === "SHOP" && g.commercialState !== "RETIRED",
              ),
            available:
              (quantity
                ? new Prisma.Decimal(quantity.available).toString()
                : null) ??
              count(
                (g) =>
                  g.ownership === "SHOP" &&
                  g.custody === "SHOP" &&
                  g.condition === "GOOD" &&
                  g.commercialState === "AVAILABLE",
              ),
            replaceable: count(
              (g) =>
                g.ownership === "SHOP" &&
                g.custody === "SHOP" &&
                g.condition === "FAULTY" &&
                g.commercialState !== "RETIRED",
            ),
            reserved: count((g) => g.commercialState === "RESERVED"),
            sentToCompany: count(
              (g) =>
                g.ownership === "SHOP" &&
                g.custody === "SUPPLIER" &&
                g.commercialState !== "RETIRED",
            ),
          };
          return stock;
        }),
        total,
        page: query.page,
        pageSize: query.pageSize,
      },
    };
  }

  @Delete("product-types/:id")
  @Permissions("catalog.write")
  async deleteType(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(validation(DeleteProductTypeDto)) body: DeleteProductTypeDto,
  ) {
    void id;
    void body;
    throw new ConflictException(
      "Permanent product categories cannot be deleted.",
    );
  }

  @Post("categories")
  @Permissions("catalog.write")
  async createCategory(
    @Body(validation(CreateCategoryDto)) body: CreateCategoryDto,
    @Req() req: AuthRequest,
  ) {
    const category = await nativeCreate(
      this.db,
      req,
      "MOBILE_CATEGORY_CREATE",
      body,
      async (tx, id) => {
        const type = await tx.productType.findUnique({
          where: { id: body.typeId },
        });
        if (!type?.active || !productCategoryCodes.includes(type.code))
          throw new BadRequestException("Select an active product type.");
        const category = await tx.category.upsert({
          where: { normalizedName: normalize(body.name) },
          update: {},
          create: {
            ...(id ? { id } : {}),
            name: body.name,
            normalizedName: normalize(body.name),
          },
        });
        if (!category.active)
          throw new ConflictException("This category is inactive.");
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${category.id}::uuid FOR UPDATE`;
        await tx.productTypeCategory.upsert({
          where: {
            typeId_categoryId: { typeId: type.id, categoryId: category.id },
          },
          update: {},
          create: { typeId: type.id, categoryId: category.id },
        });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "CATEGORY_ADDED",
            resourceType: "Category",
            resourceId: category.id,
            requestId: req.requestId,
            metadata: { typeId: type.id },
          },
        });
        return category;
      },
    );
    return {
      data: {
        id: category.id,
        name: category.name,
        typeIds: [body.typeId],
        productCount: 0,
      },
    };
  }

  @Delete("categories/:id")
  @Permissions("catalog.write")
  async deleteCategory(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(validation(DeleteCategoryDto)) body: DeleteCategoryDto,
    @Req() req: AuthRequest,
  ) {
    await this.db.$transaction(async (tx) => {
      // Names can be shared by types; serialize unlinking with name/product creation.
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id}::uuid FOR UPDATE`;
      const link = await tx.productTypeCategory.findUnique({
        where: { typeId_categoryId: { typeId: body.typeId, categoryId: id } },
        include: { category: { select: { name: true } } },
      });
      if (!link)
        throw new NotFoundException("Product name not found in this category.");
      if (
        await tx.product.count({
          where: { typeId: body.typeId, categoryId: id },
        })
      )
        throw new ConflictException(
          "Products use this name in the selected category. It cannot be deleted.",
        );
      await tx.productTypeCategory.delete({
        where: { typeId_categoryId: { typeId: body.typeId, categoryId: id } },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.currentUser!.id,
          action: "PRODUCT_NAME_DELETED",
          resourceType: "Category",
          resourceId: id,
          requestId: req.requestId,
          metadata: { typeId: body.typeId, name: link.category.name },
        },
      });
    });
    return { data: { deleted: true } };
  }

  @Get("products/:id")
  async product(@Param("id", ParseUUIDPipe) id: string) {
    const product = await this.db.product.findUnique({
      where: { id },
      select: {
        ...productFields,
        _count: {
          select: { batches: true, purchaseItems: true, saleItems: true },
        },
      },
    });
    if (!product) throw new NotFoundException("Product not found.");
    const { _count, ...row } = product;
    return {
      data: {
        ...productDto(row),
        unitEditable:
          !_count.batches && !_count.purchaseItems && !_count.saleItems,
      },
    };
  }

  @Post("products/:id")
  @Permissions("catalog.write")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(validation(UpdateProductDto)) body: UpdateProductDto,
    @Req() req: AuthRequest,
  ) {
    try {
      const product = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${id}::uuid FOR UPDATE`;
        const current = await tx.product.findUnique({
          where: { id },
          select: productFields,
        });
        if (!current) throw new NotFoundException("Product not found.");
        if (!current.active)
          throw new BadRequestException("Inactive products cannot be edited.");
        if (current.version !== body.version)
          throw new ConflictException(
            "Product changed. Close and reopen the editor before saving again.",
          );
        if (body.unit !== current.unit) {
          const references = await tx.product.findUniqueOrThrow({
            where: { id },
            select: {
              _count: {
                select: { batches: true, purchaseItems: true, saleItems: true },
              },
            },
          });
          if (Object.values(references._count).some((count) => count > 0)) {
            throw new ConflictException(
              "The unit cannot be changed after stock or transactions have been recorded.",
            );
          }
        }
        const individual =
          current.type.trackingKind === TrackingKind.BATTERY_UNIT;
        if (individual && !body.model)
          throw new BadRequestException("Model is required for batteries.");
        const category = await tx.category.findFirst({
          where: {
            normalizedName: normalize(body.name),
            active: true,
            types: { some: { typeId: current.type.id } },
          },
        });
        if (!category)
          throw new BadRequestException(
            "Select a product name in this product category.",
          );
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${category.id}::uuid FOR UPDATE`;
        const availableName = await tx.category.findFirst({
          where: {
            id: category.id,
            active: true,
            types: { some: { typeId: current.type.id } },
          },
          select: { id: true },
        });
        if (!availableName)
          throw new BadRequestException(
            "Select a product name in this product category.",
          );
        // Match creation identity rules without changing tracking kind or stock records.
        const identityKey = digest(
          JSON.stringify([
            current.type.id,
            normalize(category.name),
            normalize(body.model),
            current.brand?.id ?? null,
            category.id,
            individual && current.batteryDetail?.capacityAh != null
              ? current.batteryDetail.capacityAh.toString()
              : null,
            individual && current.batteryDetail?.voltage != null
              ? current.batteryDetail.voltage.toString()
              : null,
            individual
              ? null
              : normalize(current.partsDetail?.specifications ?? ""),
          ]),
        );
        const updated = await tx.product.update({
          where: { id },
          data: {
            name: category.name,
            model: body.model,
            unit: body.unit,
            categoryId: category.id,
            identityKey,
            defaultSellingPrice: body.defaultSellingPrice,
            version: { increment: 1 },
            ...(individual
              ? {
                  batteryDetail: {
                    update: { defaultWarrantyMonths: body.warrantyMonths },
                  },
                }
              : {
                  partsDetail: {
                    update: { defaultWarrantyMonths: body.warrantyMonths },
                  },
                }),
          },
          select: productFields,
        });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "PRODUCT_UPDATED",
            resourceType: "Product",
            resourceId: id,
            requestId: req.requestId,
            metadata: {
              before: productDto(current),
              after: productDto(updated),
            } as Prisma.InputJsonObject,
          },
        });
        return updated;
      });
      return { data: productDto(product) };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A product with this name and model already exists.",
        );
      }
      throw error;
    }
  }

  @Post("products")
  @Permissions("catalog.write")
  async create(
    @Body(validation(CreateProductDto)) body: CreateProductDto,
    @Req() req: AuthRequest,
  ) {
    const product = await nativeCreate(
      this.db,
      req,
      "MOBILE_PRODUCT_CREATE",
      body,
      async (tx, id) => {
        const type = await tx.productType.findUnique({
          where: { id: body.typeId },
        });
        if (!type?.active || !productCategoryCodes.includes(type.code))
          throw new BadRequestException("Select an active product type.");
        const individual = type.trackingKind === TrackingKind.BATTERY_UNIT;
        if (individual && !body.model?.trim())
          throw new BadRequestException("Model is required for batteries.");
        if (
          individual &&
          ((body.capacityAh != null &&
            new Prisma.Decimal(body.capacityAh).lte(0)) ||
            (body.voltage != null && new Prisma.Decimal(body.voltage).lte(0)))
        )
          throw new BadRequestException(
            "Capacity and voltage must be positive when provided.",
          );
        if (!individual && !body.category)
          throw new BadRequestException(
            "Category is required for quantity-tracked products.",
          );
        if (!individual && (body.capacityAh != null || body.voltage != null))
          throw new BadRequestException(
            "Battery identification fields do not apply to this product type.",
          );
        const brand = body.brand
          ? await tx.brand.upsert({
              where: { normalizedName: normalize(body.brand) },
              update: {},
              create: {
                name: body.brand,
                normalizedName: normalize(body.brand),
              },
            })
          : null;
        const category = body.category
          ? await tx.category.upsert({
              where: { normalizedName: normalize(body.category) },
              update: {},
              create: {
                name: body.category,
                normalizedName: normalize(body.category),
              },
            })
          : null;
        if (brand?.active === false || category?.active === false)
          throw new BadRequestException("Select an active brand and category.");
        if (category) {
          await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${category.id}::uuid FOR UPDATE`;
          await tx.productTypeCategory.upsert({
            where: {
              typeId_categoryId: { typeId: type.id, categoryId: category.id },
            },
            update: {},
            create: { typeId: type.id, categoryId: category.id },
          });
        }
        const identityKey = digest(
          JSON.stringify([
            type.id,
            normalize(body.name),
            normalize(body.model ?? ""),
            brand?.id ?? null,
            category?.id ?? null,
            individual && body.capacityAh != null
              ? new Prisma.Decimal(body.capacityAh).toString()
              : null,
            individual && body.voltage != null
              ? new Prisma.Decimal(body.voltage).toString()
              : null,
            individual ? null : normalize(body.specifications ?? ""),
          ]),
        );
        const created = await tx.product.create({
          data: {
            identityKey,
            ...(id ? { id } : {}),
            name: body.name,
            model: body.model ?? "",
            unit: body.unit,
            typeId: type.id,
            brandId: brand?.id,
            categoryId: category?.id,
            defaultSellingPrice: body.defaultSellingPrice,
            lowStockThreshold: body.lowStockThreshold,
            ...(individual
              ? {
                  batteryDetail: {
                    create: {
                      capacityAh: body.capacityAh ?? null,
                      voltage: body.voltage ?? null,
                      identificationMethod: "SERIAL",
                      defaultWarrantyMonths: body.warrantyMonths,
                    },
                  },
                }
              : {
                  partsDetail: {
                    create: {
                      specifications: body.specifications || null,
                      defaultWarrantyMonths: body.warrantyMonths,
                    },
                  },
                }),
          },
          select: productFields,
        });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "PRODUCT_CREATED",
            resourceType: "Product",
            resourceId: created.id,
            requestId: req.requestId,
          },
        });
        return created;
      },
    );
    return { data: productDto(product) };
  }
}
