import {
  BadRequestException,
  ConflictException,
  Delete,
  Patch,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsUUID,
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Permissions, type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { nativeCreate } from "./native-create";
import {
  orderProductCategories,
  productCategoryCodes,
} from "./product-categories";

import { lockBinEntry } from "./recycle-state";
import type {
  SupplierLedger,
  SupplierLedgerRecord,
} from "../../../packages/api-client/src";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

class SupplierCategoryDto {
  @IsUUID()
  productTypeId!: string;
}

class CreateSupplierDto extends SupplierCategoryDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @Transform(trimmed)
  @IsString()
  @Matches(/^[+0-9][0-9 ()-]{5,29}$/)
  phone!: string;

  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  company?: string | null;
}

class SupplierQueryDto {
  @IsOptional()
  @IsUUID()
  productTypeId?: string;

  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  q?: string;

  @IsIn(["all", "active", "inactive"])
  status = "all";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 10;
}

class DeleteSupplierDto {
  @Equals(true)
  confirmed!: boolean;
}

const contactFields = {
  productTypeId: true,
  productType: { select: { id: true, name: true } },
  id: true,
  name: true,
  company: true,
  phone: true,
  active: true,
  createdAt: true,
} as const;

function supplierWhere(query: SupplierQueryDto): Prisma.SupplierWhereInput {
  return {
    ...(query.productTypeId ? { productTypeId: query.productTypeId } : {}),
    ...(query.status === "all" ? {} : { active: query.status === "active" }),
    ...(query.q
      ? {
          OR: ["name", "company", "phone"].map((field) => ({
            [field]: { contains: query.q, mode: "insensitive" },
          })),
        }
      : {}),
  };
}

async function supplierBalances(
  tx: Prisma.TransactionClient,
  where: Prisma.SupplierWhereInput,
) {
  const [purchases, balances] = await Promise.all([
    tx.journalLine.groupBy({
      by: ["supplierId"],
      where: {
        supplier: where,
        account: { code: "2100" },
        entry: {
          posting: {
            purchaseReceipt: {
              purchase: { status: { in: ["RECEIVED", "PARTIALLY_RECEIVED"] } },
            },
          },
        },
      },
      _sum: { credit: true },
    }),
    tx.journalLine.groupBy({
      by: ["supplierId"],
      where: { supplier: where, account: { code: "2100" } },
      _sum: { debit: true, credit: true },
    }),
  ]);
  return {
    purchases: new Map(
      purchases.map((row) => [
        row.supplierId,
        row._sum.credit ?? new Prisma.Decimal(0),
      ]),
    ),
    dues: new Map(
      balances.map((row) => [
        row.supplierId,
        (row._sum.credit ?? new Prisma.Decimal(0)).sub(row._sum.debit ?? 0),
      ]),
    ),
  };
}

function supplierLedgerRecord(
  row: Prisma.SupplierGetPayload<{ select: typeof contactFields }>,
  balances: Awaited<ReturnType<typeof supplierBalances>>,
): SupplierLedgerRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    totalPurchases: (
      balances.purchases.get(row.id) ?? new Prisma.Decimal(0)
    ).toFixed(2),
    due: (balances.dues.get(row.id) ?? new Prisma.Decimal(0)).toFixed(2),
  };
}

@Controller("suppliers")
@Permissions("parties.suppliers")
export class SuppliersController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get("product-types")
  async productTypes() {
    const types = await this.db.productType.findMany({
      where: { active: true, code: { in: productCategoryCodes } },
      select: { id: true, name: true, code: true },
    });
    return {
      data: orderProductCategories(types).map(({ id, name }) => ({ id, name })),
    };
  }

  @Get("ledger")
  @Permissions("parties.suppliers", "finance.read")
  async ledgerList(
    @Query(
      new ValidationPipe({
        expectedType: SupplierQueryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: SupplierQueryDto,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const where = supplierWhere(query);
        const [rows, total, balances] = await Promise.all([
          tx.supplier.findMany({
            where,
            select: contactFields,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
          tx.supplier.count({ where }),
          supplierBalances(tx, where),
        ]);
        return {
          data: {
            items: rows.map((row) => supplierLedgerRecord(row, balances)),
            total,
            page: query.page,
            pageSize: query.pageSize,
            summary: {
              totalPurchases: [...balances.purchases.values()]
                .reduce((sum, value) => sum.add(value), new Prisma.Decimal(0))
                .toFixed(2),
              totalDue: [...balances.dues.values()]
                .reduce(
                  (sum, value) => sum.add(Prisma.Decimal.max(0, value)),
                  new Prisma.Decimal(0),
                )
                .toFixed(2),
            },
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  @Get(":id/ledger")
  @Permissions("parties.suppliers", "finance.read")
  async ledger(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ data: SupplierLedger }> {
    return this.db.$transaction(
      async (tx) => {
        const supplier = await tx.supplier.findUnique({
          where: { id },
          select: contactFields,
        });
        if (!supplier) throw new NotFoundException("Supplier not found.");
        const [balances, lines] = await Promise.all([
          supplierBalances(tx, { id }),
          tx.journalLine.findMany({
            where: { supplierId: id, account: { code: "2100" } },
            select: {
              id: true,
              debit: true,
              credit: true,
              entry: {
                select: {
                  postedAt: true,
                  reason: true,
                  payment: { select: { number: true, reference: true } },
                  posting: {
                    select: {
                      purchaseReceipt: {
                        select: {
                          purchase: {
                            select: { number: true, supplierReference: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            orderBy: [
              { entry: { postedAt: "asc" } },
              { entry: { createdAt: "asc" } },
              { credit: "desc" },
              { entryId: "asc" },
              { id: "asc" },
            ],
          }),
        ]);
        let balance = new Prisma.Decimal(0);
        const items = lines.map((line) => {
          balance = balance.add(line.credit).sub(line.debit);
          const purchase = line.entry.posting.purchaseReceipt?.purchase;
          return {
            id: line.id,
            date: line.entry.postedAt.toISOString(),
            reference:
              purchase?.supplierReference ||
              purchase?.number ||
              line.entry.payment?.reference ||
              line.entry.payment?.number ||
              "—",
            description: line.entry.reason ?? "হিসাব সমন্বয়",
            debit: line.debit.toFixed(2),
            credit: line.credit.toFixed(2),
            balance: balance.toFixed(2),
          };
        });
        return {
          data: { supplier: supplierLedgerRecord(supplier, balances), items },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  @Get("recycle-bin")
  async recycleBin() {
    const entries = await this.db.auditLog.findMany({
      where: { action: "SUPPLIER_DELETED", resourceType: "Supplier" },
      orderBy: { createdAt: "desc" },
      select: { id: true, resourceId: true, createdAt: true, metadata: true },
    });
    const finalized = await this.db.auditLog.findMany({
      where: { action: "RECYCLE_BIN_FINALIZED" },
      select: { metadata: true },
    });
    const hidden = new Set(
      finalized.map(
        (e) => (e.metadata as { entryId?: string } | null)?.entryId,
      ),
    );
    const existing = await this.db.supplier.findMany({
      where: {
        id: {
          in: entries.flatMap((entry) =>
            entry.resourceId ? [entry.resourceId] : [],
          ),
        },
      },
      select: { id: true },
    });
    const seen = new Set(existing.map((supplier) => supplier.id));
    return {
      data: entries.flatMap((entry) => {
        const metadata = entry.metadata as {
          supplier?: {
            name: string;
            phone: string | null;
            company: string | null;
          };
        } | null;
        if (
          hidden.has(entry.id) ||
          !entry.resourceId ||
          seen.has(entry.resourceId) ||
          !metadata?.supplier
        )
          return [];
        seen.add(entry.resourceId);
        return [
          {
            id: entry.id,
            name: metadata.supplier.name,
            phone: metadata.supplier.phone,
            company: metadata.supplier.company,
            deletedAt: entry.createdAt,
            type: "Supplier",
          },
        ];
      }),
    };
  }

  @Post("recycle-bin/:entryId/restore")
  async restore(
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Req() req: AuthRequest,
  ) {
    const supplier = await this.db.$transaction(
      async (tx) => {
        return restoreDeletedSupplier(tx, entryId, req);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { data: supplier };
  }

  @Post(":id/category")
  async setCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(
      new ValidationPipe({
        expectedType: SupplierCategoryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: SupplierCategoryDto,
    @Req() req: AuthRequest,
  ) {
    const supplier = await this.db.$transaction(async (tx) => {
      const category = await tx.productType.findFirst({
        where: {
          id: body.productTypeId,
          active: true,
          code: { in: productCategoryCodes },
        },
      });
      if (!category)
        throw new BadRequestException("Select an active product category.");
      const existing = await tx.supplier.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("Supplier not found.");
      const updated = await tx.supplier.update({
        where: { id },
        data: { productTypeId: category.id },
        select: contactFields,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.currentUser!.id,
          action: "SUPPLIER_CATEGORY_UPDATED",
          resourceType: "Supplier",
          resourceId: id,
          requestId: req.requestId,
        },
      });
      return updated;
    });
    return { data: supplier };
  }

  @Get()
  async list(
    @Query(
      new ValidationPipe({
        expectedType: SupplierQueryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: SupplierQueryDto,
  ) {
    const where = supplierWhere(query);
    const [items, total] = await this.db.$transaction([
      this.db.supplier.findMany({
        where,
        select: contactFields,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.supplier.count({ where }),
    ]);
    return {
      data: {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
      },
    };
  }

  @Post()
  async create(
    @Body(
      new ValidationPipe({
        expectedType: CreateSupplierDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: CreateSupplierDto,
    @Req() req: AuthRequest,
  ) {
    const supplier = await nativeCreate(
      this.db,
      req,
      "MOBILE_SUPPLIER_CREATE",
      body,
      async (tx, id) => {
        const category = await tx.productType.findFirst({
          where: {
            id: body.productTypeId,
            active: true,
            code: { in: productCategoryCodes },
          },
        });
        if (!category)
          throw new BadRequestException("Select an active product category.");
        const created = await tx.supplier.create({
          data: {
            productTypeId: category.id,
            ...(id ? { id } : {}),
            name: body.name,
            phone: body.phone,
            company: body.company || null,
          },
          select: contactFields,
        });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "SUPPLIER_CREATED",
            resourceType: "Supplier",
            resourceId: created.id,
            requestId: req.requestId,
          },
        });
        return created;
      },
    );
    return { data: supplier };
  }

  @Patch(":id")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(
      new ValidationPipe({
        expectedType: CreateSupplierDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: CreateSupplierDto,
    @Req() req: AuthRequest,
  ) {
    const supplier = await this.db.$transaction(async (tx) => {
      if (!(await tx.supplier.findUnique({ where: { id } })))
        throw new NotFoundException("Supplier not found.");
      const category = await tx.productType.findFirst({
        where: {
          id: body.productTypeId,
          active: true,
          code: { in: productCategoryCodes },
        },
      });
      if (!category)
        throw new BadRequestException("Select an active product category.");
      const updated = await tx.supplier.update({
        where: { id },
        data: {
          productTypeId: category.id,
          name: body.name,
          phone: body.phone,
          company: body.company || null,
        },
        select: contactFields,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.currentUser!.id,
          action: "SUPPLIER_UPDATED",
          resourceType: "Supplier",
          resourceId: id,
          requestId: req.requestId,
        },
      });
      return updated;
    });
    return { data: supplier };
  }

  @Delete(":id")
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(
      new ValidationPipe({
        expectedType: DeleteSupplierDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    _body: DeleteSupplierDto,
    @Req() req: AuthRequest,
  ) {
    try {
      await this.db.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({ where: { id } });
        if (!supplier) throw new NotFoundException("Supplier not found.");
        await tx.supplier.delete({ where: { id } });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "SUPPLIER_DELETED",
            resourceType: "Supplier",
            resourceId: id,
            requestId: req.requestId,
            metadata: {
              name: supplier.name,
              supplier: JSON.parse(JSON.stringify(supplier)),
            },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2003"
      )
        throw new ConflictException(
          "এই সাপ্লায়ারের লেনদেন আছে, তাই ডিলিট করা যাবে না।",
        );
      throw error;
    }
    return { data: { id } };
  }
}

export async function restoreDeletedSupplier(
  tx: Prisma.TransactionClient,
  entryId: string,
  req: AuthRequest,
) {
  await lockBinEntry(tx, entryId);
  const entry = await tx.auditLog.findFirst({
    where: {
      id: entryId,
      action: "SUPPLIER_DELETED",
      resourceType: "Supplier",
    },
  });
  type Snapshot = {
    id: string;
    name: string;
    company: string | null;
    phone: string | null;
    active: boolean;
    productTypeId: string | null;
    brandId: string | null;
    createdAt: string;
    version: number;
  };
  const snapshot = (entry?.metadata as { supplier?: Snapshot } | null)
    ?.supplier;
  if (!entry?.resourceId || !snapshot)
    throw new NotFoundException("Deleted supplier not found.");
  if (await tx.supplier.findUnique({ where: { id: entry.resourceId } }))
    throw new ConflictException("Supplier has already been restored.");
  const latest = await tx.auditLog.findFirst({
    where: {
      resourceType: "Supplier",
      resourceId: entry.resourceId,
      action: "SUPPLIER_DELETED",
    },
    orderBy: { createdAt: "desc" },
  });
  if (latest?.id !== entry.id)
    throw new ConflictException("Refresh the Recycle Bin and try again.");
  const restored = await tx.supplier.create({
    data: {
      id: entry.resourceId,
      name: snapshot.name,
      company: snapshot.company,
      phone: snapshot.phone,
      active: snapshot.active,
      productTypeId: snapshot.productTypeId,
      brandId: snapshot.brandId,
      createdAt: new Date(snapshot.createdAt),
      version: snapshot.version,
    },
    select: contactFields,
  });
  await tx.auditLog.create({
    data: {
      actorId: req.currentUser!.id,
      action: "SUPPLIER_RESTORED",
      resourceType: "Supplier",
      resourceId: restored.id,
      requestId: req.requestId,
      metadata: { deletionId: entry.id },
    },
  });
  return restored;
}
