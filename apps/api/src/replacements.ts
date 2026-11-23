import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Prisma, type ReplacementStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsUUID,
  Equals,
} from "class-validator";
import { randomUUID } from "node:crypto";
import {
  replacementStatuses,
  type ReplacementStage,
} from "../../../packages/api-client/src";
import { type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { nativeCreate } from "./native-create";

const groups: Record<ReplacementStage, ReplacementStatus[]> = {
  FAULTY: ["PENDING_RETURN", "REJECTED"],
  SENT: ["SENT_TO_COMPANY", "UNDER_REVIEW"],
  RECEIVED: ["REPLACEMENT_RECEIVED", "READY_FOR_CUSTOMER_DELIVERY"],
  DELIVERED: ["COMPLETED"],
};
const stageOf = (status: ReplacementStatus): ReplacementStage =>
  replacementStatuses.find((stage) => groups[stage].includes(status))!;
const permissionFor: Record<ReplacementStage, string> = {
  FAULTY: "replacements.resolve",
  SENT: "replacements.dispatch",
  RECEIVED: "replacements.receive",
  DELIVERED: "replacements.deliver",
};
class ListDto {
  @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsIn(["all", ...replacementStatuses]) status: "all" | ReplacementStage =
    "all";
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
}
class StatusDto {
  @IsIn(replacementStatuses) status!: ReplacementStage;
  @IsInt() @Min(1) version!: number;
}
class DeleteReplacementDto {
  @IsInt() @Min(1) version!: number;
  @Equals(true) confirmed!: boolean;
}
class OptionsDto {
  @IsIn(["BEFORE_SALE", "CUSTOMER_WARRANTY"]) source:
    "BEFORE_SALE" | "CUSTOMER_WARRANTY" = "CUSTOMER_WARRANTY";
  @IsOptional() @IsString() @MaxLength(160) q?: string;
}
class IntakeDto extends OptionsDto {
  @IsInt() @Min(1) @Max(100) quantity = 1;
  @IsUUID() id!: string;
  @IsUUID() unitId!: string;
  @IsOptional() @IsUUID() saleUnitId?: string;
  @IsUUID() supplierId!: string;
  @IsString() @MaxLength(2000) faultReason = "";
}
const validation = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

@Controller("replacements")
export class ReplacementsController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get("options")
  async options(
    @Req() req: AuthRequest,
    @Query(validation(OptionsDto)) query: OptionsDto,
  ) {
    const permission =
      query.source === "BEFORE_SALE"
        ? "replacements.intake.stock"
        : "replacements.intake.customer";
    if (!req.currentUser!.permissions.includes(permission))
      throw new ForbiddenException(
        "You do not have permission for this replacement source.",
      );
    const suppliers = await this.db.supplier.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const term = query.q?.trim();
    const contains = { contains: term, mode: "insensitive" as const };
    const noOpenCase: Prisma.BatteryUnitWhereInput = {
      replacementCases: {
        none: { status: { not: "COMPLETED" }, outcomeResolvedAt: null },
      },
    };
    const batch = {
      include: {
        receiptItem: {
          include: { purchaseItem: { include: { purchase: true } } },
        },
      },
    } as const;
    if (query.source === "CUSTOMER_WARRANTY") {
      const sales = await this.db.saleUnit.findMany({
        where: {
          releasedAt: null,
          saleItem: {
            sale: { status: { in: ["CONFIRMED", "PARTIALLY_RETURNED"] } },
          },
          batteryUnit: {
            ...noOpenCase,
            ownership: "CUSTOMER",
            custody: "CUSTOMER",
          },
          ...(term
            ? {
                OR: [
                  { saleItem: { sale: { invoiceNumber: contains } } },
                  { saleItem: { sale: { customer: { name: contains } } } },
                  { saleItem: { sale: { customer: { phone: contains } } } },
                  { saleItem: { product: { model: contains } } },
                  { saleItem: { product: { name: contains } } },
                  { batteryUnit: { serialNumber: contains } },
                  { batteryUnit: { internalCode: contains } },
                ],
              }
            : {}),
        },
        include: {
          batteryUnit: { include: { product: true, batch } },
          saleItem: { include: { sale: { include: { customer: true } } } },
        },
        orderBy: { createdAt: "desc" },
        distinct: ["saleItemId"],
        take: 100,
      });
      return {
        data: {
          suppliers,
          units: sales.map((sale) => ({
            id: sale.batteryUnitId,
            productId: sale.batteryUnit.productId,
            saleUnitId: sale.id,
            label: [
              sale.batteryUnit.product.name,
              sale.batteryUnit.product.model,
            ]
              .filter(Boolean)
              .join(" · "),
            supplierId:
              sale.batteryUnit.batch.receiptItem?.purchaseItem.purchase
                .supplierId ?? null,
            customer: sale.saleItem.sale.customer.name,
            invoice: sale.saleItem.sale.invoiceNumber,
          })),
        },
      };
    }
    const units = await this.db.batteryUnit.findMany({
      where: {
        ...noOpenCase,
        ownership: "SHOP",
        custody: "SHOP",
        commercialState: { in: ["AVAILABLE", "UNAVAILABLE"] },
        reservedCustomerId: null,
        reservedReplacementId: null,
        saleHistory: { none: { releasedAt: null } },
        ...(term
          ? {
              OR: [
                { product: { name: contains } },
                { product: { model: contains } },
                { serialNumber: contains },
                { internalCode: contains },
              ],
            }
          : {}),
      },
      include: { product: true, batch },
      orderBy: { createdAt: "desc" },
      distinct: ["productId"],
      take: 100,
    });
    return {
      data: {
        suppliers,
        units: units.map((unit) => ({
          id: unit.id,
          productId: unit.productId,
          saleUnitId: null,
          label: [unit.product.name, unit.product.model]
            .filter(Boolean)
            .join(" · "),
          supplierId:
            unit.batch.receiptItem?.purchaseItem.purchase.supplierId ?? null,
          customer: null,
          invoice: null,
        })),
      },
    };
  }

  @Post()
  async create(
    @Req() req: AuthRequest,
    @Body(validation(IntakeDto)) body: IntakeDto,
  ) {
    const permission =
      body.source === "BEFORE_SALE"
        ? "replacements.intake.stock"
        : "replacements.intake.customer";
    if (!req.currentUser!.permissions.includes(permission))
      throw new ForbiddenException(
        "You do not have permission for this replacement source.",
      );
    try {
      const data = await this.db.$transaction(
        async (tx) => {
          const prior = await tx.replacementRecord.findUnique({
            where: { id: body.id },
          });
          if (prior) {
            if (prior.outcome === "CANCELLED")
              throw new ConflictException(
                "This registration was deleted. Start a new replacement.",
              );
            if (
              prior.oldUnitId !== body.unitId ||
              prior.supplierId !== body.supplierId ||
              prior.source !== body.source ||
              prior.faultReason !== body.faultReason.trim()
            )
              throw new ConflictException(
                "This request was already used for another replacement.",
              );
            const audit = await tx.auditLog.findFirst({
              where: { resourceId: prior.id, action: "REPLACEMENT_CREATED" },
            });
            const savedQuantity =
              (audit?.metadata as Prisma.JsonObject | undefined)?.quantity ?? 1;
            if (savedQuantity !== body.quantity)
              throw new ConflictException(
                "This registration was already saved with a different quantity.",
              );
            return {
              id: prior.id,
              number: prior.number,
              quantity: savedQuantity,
            };
          }
          if (
            !(await tx.supplier.findFirst({
              where: { id: body.supplierId, active: true },
            }))
          )
            throw new BadRequestException("Select an active supplier.");
          const anchor = await tx.batteryUnit.findUnique({
            where: { id: body.unitId },
          });
          if (!anchor) throw new NotFoundException("Battery not found.");
          const noOpenCase = {
            replacementCases: {
              none: {
                status: { not: "COMPLETED" as const },
                outcomeResolvedAt: null,
              },
            },
          };
          const targets: { unitId: string; saleUnitId?: string }[] = [
            { unitId: body.unitId, saleUnitId: body.saleUnitId },
          ];
          if (body.quantity > 1) {
            if (body.source === "CUSTOMER_WARRANTY") {
              const selectedSale = body.saleUnitId
                ? await tx.saleUnit.findFirst({
                    where: { id: body.saleUnitId, batteryUnitId: body.unitId },
                    include: { saleItem: true },
                  })
                : null;
              if (!selectedSale)
                throw new BadRequestException("Select the customer invoice.");
              const additional = await tx.saleUnit.findMany({
                where: {
                  releasedAt: null,
                  batteryUnitId: { not: body.unitId },
                  saleItem: {
                    saleId: selectedSale.saleItem.saleId,
                    productId: anchor.productId,
                  },
                  batteryUnit: {
                    ...noOpenCase,
                    ownership: "CUSTOMER",
                    custody: "CUSTOMER",
                  },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: body.quantity - 1,
              });
              targets.push(
                ...additional.map((sale) => ({
                  unitId: sale.batteryUnitId,
                  saleUnitId: sale.id,
                })),
              );
            } else {
              const additional = await tx.batteryUnit.findMany({
                where: {
                  ...noOpenCase,
                  id: { not: body.unitId },
                  productId: anchor.productId,
                  ownership: "SHOP",
                  custody: "SHOP",
                  commercialState: { in: ["AVAILABLE", "UNAVAILABLE"] },
                  reservedCustomerId: null,
                  reservedReplacementId: null,
                  saleHistory: { none: { releasedAt: null } },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: body.quantity - 1,
              });
              targets.push(...additional.map((unit) => ({ unitId: unit.id })));
            }
            if (targets.length !== body.quantity)
              throw new ConflictException(
                "The selected model does not have enough eligible batteries for this quantity.",
              );
          }
          async function registerOne(
            unitId: string,
            saleUnitId: string | undefined,
            recordId: string,
          ) {
            const unit = await tx.batteryUnit.findUnique({
              where: { id: unitId },
              include: {
                replacementCases: {
                  where: {
                    status: { not: "COMPLETED" },
                    outcomeResolvedAt: null,
                  },
                },
              },
            });
            if (!unit) throw new NotFoundException("Battery not found.");
            if (unit.replacementCases.length)
              throw new ConflictException(
                "This battery already has an open replacement case.",
              );
            let warrantyClaimId: string | undefined;
            let reservedCustomerId: string | undefined;
            if (body.source === "CUSTOMER_WARRANTY") {
              const sale = saleUnitId
                ? await tx.saleUnit.findFirst({
                    where: {
                      id: saleUnitId,
                      batteryUnitId: unit.id,
                      releasedAt: null,
                      saleItem: {
                        sale: {
                          status: { in: ["CONFIRMED", "PARTIALLY_RETURNED"] },
                        },
                      },
                    },
                    include: {
                      saleItem: {
                        include: { sale: { include: { customer: true } } },
                      },
                    },
                  })
                : null;
              if (
                !sale ||
                unit.ownership !== "CUSTOMER" ||
                unit.custody !== "CUSTOMER"
              )
                throw new ConflictException(
                  "Select a currently sold customer battery.",
                );
              reservedCustomerId = sale.saleItem.sale.customerId;
              const date = new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Dhaka",
              }).format(new Date());
              const receivedDate = new Date(date + "T00:00:00Z");
              const eligible = receivedDate <= sale.coverageExpiry;
              const claim = await tx.warrantyClaim.create({
                data: {
                  number: "WC-" + randomUUID(),
                  complaint: body.faultReason.trim(),
                  eligible,
                  eligibilityReason: eligible
                    ? "Within original warranty period"
                    : "Outside original warranty period; requires review",
                  policySnapshot: sale.saleItem
                    .warrantySnapshot as Prisma.InputJsonValue,
                  receivedDate,
                  originalExpiry: sale.coverageExpiry,
                  receiptSnapshot: {
                    invoiceNumber: sale.saleItem.sale.invoiceNumber,
                    customer: sale.saleItem.sale.customer.name,
                  },
                  customerId: reservedCustomerId,
                  saleUnitId: sale.id,
                  faultyUnitId: unit.id,
                },
              });
              warrantyClaimId = claim.id;
            } else if (
              unit.ownership !== "SHOP" ||
              unit.custody !== "SHOP" ||
              !["AVAILABLE", "UNAVAILABLE"].includes(unit.commercialState) ||
              unit.reservedCustomerId ||
              unit.reservedReplacementId ||
              (await tx.saleUnit.count({
                where: { batteryUnitId: unit.id, releasedAt: null },
              }))
            ) {
              throw new ConflictException("Select an unreserved shop battery.");
            }
            const locked = await tx.batteryUnit.updateMany({
              where: { id: unit.id, version: unit.version },
              data: {
                condition: "FAULTY",
                custody: "SHOP",
                commercialState: "UNAVAILABLE",
                version: { increment: 1 },
              },
            });
            if (!locked.count)
              throw new ConflictException(
                "This battery changed. Refresh and try again.",
              );
            const record = await tx.replacementRecord.create({
              data: {
                id: recordId,
                number: "REP-" + recordId.slice(0, 8).toUpperCase(),
                source: body.source,
                oldUnitId: unit.id,
                supplierId: body.supplierId,
                faultReason: body.faultReason.trim(),
                warrantyClaimId,
                reservedCustomerId,
              },
            });
            const posting = await tx.posting.create({
              data: {
                kind: "REPLACEMENT_INTAKE",
                sourceCode: "replacement-intake:" + record.id,
                actorId: req.currentUser!.id,
              },
            });
            await tx.stockMovement.create({
              data: {
                postingId: posting.id,
                lineNumber: 1,
                productId: unit.productId,
                batchId: unit.batchId,
                batteryUnitId: unit.id,
                quantity: 1,
                fromCustody: unit.custody,
                toCustody: "SHOP",
                fromState: unit.commercialState,
                toState: "UNAVAILABLE",
                fromCondition: unit.condition,
                toCondition: "FAULTY",
                fromOwnership: unit.ownership,
                toOwnership: unit.ownership,
                reason: "Replacement intake " + record.number,
              },
            });
            await tx.auditLog.create({
              data: {
                actorId: req.currentUser!.id,
                requestId: req.requestId,
                action: "REPLACEMENT_CREATED",
                resourceType: "ReplacementRecord",
                resourceId: record.id,
                metadata: {
                  source: body.source,
                  oldUnitId: unit.id,
                  registrationId: body.id,
                  quantity: body.quantity,
                },
              },
            });
            return { id: record.id, number: record.number };
          }
          const records = [];
          for (const [index, target] of targets.entries()) {
            records.push(
              await registerOne(
                target.unitId,
                target.saleUnitId,
                index === 0 ? body.id : randomUUID(),
              ),
            );
          }
          return { ...records[0], quantity: records.length };
        },
        { timeout: 60_000 },
      );
      return { data };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "This battery already has a replacement case. Refresh the list.",
        );
      throw error;
    }
  }

  @Get()
  async list(
    @Req() req: AuthRequest,
    @Query(validation(ListDto)) query: ListDto,
  ) {
    if (
      !req.currentUser!.permissions.some((permission) =>
        permission.startsWith("replacements."),
      )
    )
      throw new ForbiddenException(
        "You do not have permission to view replacements.",
      );
    const contains = {
      contains: query.q?.trim(),
      mode: "insensitive" as const,
    };
    const where: Prisma.ReplacementRecordWhereInput = {
      AND: [{ OR: [{ outcome: null }, { outcome: { not: "CANCELLED" } }] }],
      ...(query.status === "all"
        ? {}
        : { status: { in: groups[query.status] } }),
      ...(query.q?.trim()
        ? {
            OR: [
              { number: contains },
              { oldUnit: { serialNumber: contains } },
              { oldUnit: { product: { name: contains } } },
              { reservedCustomer: { name: contains } },
              { warrantyClaim: { customer: { name: contains } } },
              {
                warrantyClaim: {
                  saleUnit: { saleItem: { sale: { invoiceNumber: contains } } },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total, counts] = await this.db.$transaction([
      this.db.replacementRecord.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          oldUnit: { include: { product: true } },
          reservedCustomer: true,
          supplier: true,
          warrantyClaim: {
            include: {
              customer: true,
              saleUnit: { include: { saleItem: { include: { sale: true } } } },
            },
          },
          dispatchItems: {
            include: { dispatch: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
      this.db.replacementRecord.count({ where }),
      this.db.replacementRecord.groupBy({
        where: { OR: [{ outcome: null }, { outcome: { not: "CANCELLED" } }] },
        by: ["status"],
        orderBy: { status: "asc" },
        _count: { _all: true },
      }),
    ]);
    const summary = { FAULTY: 0, SENT: 0, RECEIVED: 0, DELIVERED: 0 };
    for (const count of counts) {
      if (typeof count._count === "object")
        summary[stageOf(count.status)] += count._count._all ?? 0;
    }
    return {
      data: {
        items: items.map((item) => ({
          id: item.id,
          number: item.number,
          source: item.source,
          status: stageOf(item.status),
          version: item.version,
          product: item.oldUnit.product.name,
          serial: item.oldUnit.serialNumber ?? item.oldUnit.internalCode,
          customer:
            (item.reservedCustomer ?? item.warrantyClaim?.customer)?.name ??
            null,
          phone:
            (item.reservedCustomer ?? item.warrantyClaim?.customer)?.phone ??
            null,
          invoice:
            item.warrantyClaim?.saleUnit.saleItem.sale.invoiceNumber ?? null,
          supplier: item.supplier.name,
          createdAt: item.createdAt,
          sentAt: item.dispatchItems[0]?.dispatch.dispatchDate ?? null,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        summary,
      },
    };
  }

  @Post(":id/status")
  async updateStatus(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(validation(StatusDto)) body: StatusDto,
  ) {
    if (!req.currentUser!.permissions.includes(permissionFor[body.status]))
      throw new ForbiddenException(
        "You do not have permission to set this status.",
      );
    const data = await nativeCreate(
      this.db,
      req,
      "MOBILE_REPLACEMENT_STATUS",
      { id, ...body },
      async (tx) => {
        const current = await tx.replacementRecord.findUnique({
          where: { id },
        });
        if (!current)
          throw new NotFoundException("Replacement case not found.");
        if (current.outcome === "CANCELLED")
          throw new ConflictException("This replacement was deleted.");
        if (current.version !== body.version)
          throw new ConflictException(
            "This case was changed by another user. Refresh and try again.",
          );
        if (stageOf(current.status) === body.status)
          return { id, status: body.status, version: current.version };
        const updated = await tx.replacementRecord.updateMany({
          where: { id, version: body.version },
          data: { status: groups[body.status][0], version: { increment: 1 } },
        });
        if (!updated.count)
          throw new ConflictException(
            "This case was changed by another user. Refresh and try again.",
          );
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            requestId: req.requestId,
            action: "REPLACEMENT_STATUS_CHANGED",
            resourceType: "ReplacementRecord",
            resourceId: id,
            metadata: { from: current.status, to: groups[body.status][0] },
          },
        });
        return { id, status: body.status, version: current.version + 1 };
      },
    );
    return { data };
  }

  @Delete(":id")
  async remove(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(validation(DeleteReplacementDto)) body: DeleteReplacementDto,
  ) {
    if (
      !req.currentUser!.permissions.includes("transactions.reverse") ||
      !req.currentUser!.permissions.includes("replacements.resolve")
    )
      throw new ForbiddenException(
        "You do not have permission to delete replacements.",
      );
    const data = await this.db.$transaction(
      async (tx) => {
        // Serialize deletes and status changes before touching the battery.
        await tx.$queryRaw`SELECT id FROM "ReplacementRecord" WHERE id = ${id}::uuid FOR UPDATE`;
        const record = await tx.replacementRecord.findUnique({
          where: { id },
          include: {
            dispatchItems: true,
            receiptItem: true,
            reservedUnits: true,
          },
        });
        if (!record) throw new NotFoundException("Replacement case not found.");
        if (record.outcome === "CANCELLED") return { id, deleted: true };
        if (record.version !== body.version)
          throw new ConflictException(
            "This case changed. Refresh and try again.",
          );
        if (
          record.dispatchItems.length ||
          record.receiptItem ||
          record.reservedUnits.length ||
          record.outcomeResolvedAt
        )
          throw new ConflictException(
            "This replacement has dependent stock transactions and cannot be deleted.",
          );
        await tx.$queryRaw`SELECT id FROM "BatteryUnit" WHERE id = ${record.oldUnitId}::uuid FOR UPDATE`;
        const unit = await tx.batteryUnit.findUniqueOrThrow({
          where: { id: record.oldUnitId },
        });
        const intake = await tx.stockMovement.findFirst({
          where: {
            batteryUnitId: unit.id,
            posting: { sourceCode: "replacement-intake:" + id },
          },
          include: { reversals: true },
        });
        if (
          !intake ||
          intake.reversals ||
          !intake.fromCustody ||
          !intake.fromState ||
          !intake.fromCondition ||
          !intake.fromOwnership
        )
          throw new ConflictException(
            "The original replacement stock movement cannot be reversed.",
          );
        if (
          unit.custody !== intake.toCustody ||
          unit.commercialState !== intake.toState ||
          unit.condition !== intake.toCondition ||
          unit.ownership !== intake.toOwnership ||
          unit.reservedCustomerId ||
          unit.reservedReplacementId ||
          (await tx.stockMovement.count({
            where: {
              batteryUnitId: unit.id,
              id: { not: intake.id },
              createdAt: { gte: intake.createdAt },
            },
          }))
        )
          throw new ConflictException(
            "This battery changed after registration. Its later stock transactions must be reversed first.",
          );
        const reason = "Delete replacement " + record.number;
        const posting = await tx.posting.create({
          data: {
            kind: "REPLACEMENT_INTAKE_REVERSAL",
            sourceCode: "replacement-delete:" + id,
            actorId: req.currentUser!.id,
            reason,
          },
        });
        await tx.stockMovement.create({
          data: {
            postingId: posting.id,
            lineNumber: 1,
            productId: intake.productId,
            batchId: intake.batchId,
            batteryUnitId: unit.id,
            quantity: intake.quantity,
            reversedMovementId: intake.id,
            fromCustody: intake.toCustody,
            toCustody: intake.fromCustody,
            fromState: intake.toState,
            toState: intake.fromState,
            fromCondition: intake.toCondition,
            toCondition: intake.fromCondition,
            fromOwnership: intake.toOwnership,
            toOwnership: intake.fromOwnership,
            reason,
          },
        });
        const restored = await tx.batteryUnit.updateMany({
          where: { id: unit.id, version: unit.version },
          data: {
            custody: intake.fromCustody,
            commercialState: intake.fromState,
            condition: intake.fromCondition,
            ownership: intake.fromOwnership,
            version: { increment: 1 },
          },
        });
        if (!restored.count)
          throw new ConflictException(
            "This battery changed. Refresh and try again.",
          );
        const cancelled = await tx.replacementRecord.updateMany({
          where: { id, version: record.version },
          data: {
            outcome: "CANCELLED",
            outcomeResolvedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (!cancelled.count)
          throw new ConflictException(
            "This case changed. Refresh and try again.",
          );
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            requestId: req.requestId,
            action: "REPLACEMENT_DELETED",
            resourceType: "ReplacementRecord",
            resourceId: id,
            metadata: {
              source: record.source,
              oldUnitId: unit.id,
              reversalPostingId: posting.id,
            },
          },
        });
        return { id, deleted: true };
      },
      { timeout: 30_000 },
    );
    return { data };
  }
}
