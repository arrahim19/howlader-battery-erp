import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ValidationPipe,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  isUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import type {
  CustomerRecord,
  CustomerLedger,
} from "../../../packages/api-client/src";
import type { AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { businessRange } from "./dashboard";
import { nativeCreate } from "./native-create";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
class CreateCustomerDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @Transform(trim)
  @IsString()
  @Matches(/^[+0-9][0-9 ()-]{5,29}$/)
  phone!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) address!: string;
}
class CustomersQueryDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsIn(["all", "active", "inactive"]) status = "all";
  @IsIn(["all", "due", "clear"]) credit = "all";
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
}
class CustomerSalesQueryDto {
  @IsOptional() @IsUUID() saleId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 10;
}
class CustomerLedgerQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
class CollectCustomerPaymentDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @Matches(/^\d{1,14}(?:\.\d{1,2})?$/) amount!: string;
  @IsUUID() paymentAccountId!: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) reference?: string;
}
const validation = (expectedType: new () => object) =>
  new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
export const customerFields = {
  id: true,
  name: true,
  phone: true,
  address: true,
  active: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;
type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerFields }>;
export const postedSales = [
  "CONFIRMED",
  "PARTIALLY_RETURNED",
  "RETURNED",
] as const;

export async function customerRecords(
  db: Pick<Prisma.TransactionClient, "sale" | "journalLine">,
  rows: CustomerRow[],
): Promise<CustomerRecord[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [sales, balances] = await Promise.all([
    db.sale.groupBy({
      by: ["customerId"],
      where: { customerId: { in: ids }, status: { in: [...postedSales] } },
      _sum: { total: true },
    }),
    db.journalLine.groupBy({
      by: ["customerId"],
      where: { customerId: { in: ids }, account: { code: "1200" } },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const totals = new Map(
    sales.map((sale) => [
      sale.customerId,
      sale._sum.total ?? new Prisma.Decimal(0),
    ]),
  );
  const dues = new Map(
    balances.map((balance) => [
      balance.customerId,
      (balance._sum?.debit ?? new Prisma.Decimal(0)).sub(
        balance._sum?.credit ?? 0,
      ),
    ]),
  );
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    totalSales: (totals.get(row.id) ?? new Prisma.Decimal(0)).toFixed(2),
    due: (dues.get(row.id) ?? new Prisma.Decimal(0)).toFixed(2),
  }));
}

function checkAccess(req: AuthRequest) {
  if (
    !req.currentUser!.permissions.some((permission) =>
      ["parties.customers", "sales.manage"].includes(permission),
    )
  )
    throw new ForbiddenException(
      "You do not have permission to manage customers.",
    );
}

@Controller("customers")
export class CustomersController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get(":id/ledger")
  async ledger(
    @Param("id", ParseUUIDPipe) id: string,
    @Query(validation(CustomerLedgerQueryDto)) query: CustomerLedgerQueryDto,
    @Req() req: AuthRequest,
  ): Promise<{ data: CustomerLedger }> {
    checkAccess(req);
    if (Boolean(query.from) !== Boolean(query.to))
      throw new BadRequestException("Choose both a start and end date.");
    const range =
      query.from && query.to ? businessRange(query.from, query.to) : null;
    return this.db.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({
          where: { id },
          select: customerFields,
        });
        if (!customer) throw new NotFoundException("Customer not found.");
        const entries = await tx.journalEntry.findMany({
          where: {
            lines: { some: { customerId: id, account: { code: "1200" } } },
          },
          include: {
            lines: { where: { customerId: id, account: { code: "1200" } } },
            payment: { select: { occurredAt: true } },
            posting: true,
          },
        });
        const journalById = new Map(entries.map((entry) => [entry.id, entry]));
        function originalJournal(journalId: string) {
          let journal = journalById.get(journalId);
          const visited = new Set<string>();
          while (journal?.reversedEntryId && !visited.has(journal.id)) {
            visited.add(journal.id);
            const original = journalById.get(journal.reversedEntryId);
            if (!original) break;
            journal = original;
          }
          return journal;
        }
        const sales = await tx.sale.findMany({
          where: { customerId: id, status: { in: [...postedSales] } },
          include: {
            returns: true,
            paymentAllocations: {
              where: {
                reversedAllocationId: null,
                reversal: { is: null },
                payment: { reversedPaymentId: null, reversal: { is: null } },
              },
              include: { payment: true },
            },
          },
        });
        type Event = {
          id: string;
          date: Date;
          reference: string;
          description: string;
          kind: CustomerLedger["items"][number]["kind"];
          debit: Prisma.Decimal;
          credit: Prisma.Decimal;
        };
        const events: Event[] = [];
        const collections = new Map<string, Event>();
        for (const sale of sales) {
          let initialPaid = new Prisma.Decimal(0);
          for (const allocation of sale.paymentAllocations) {
            const payment = allocation.payment;
            const original = originalJournal(payment.journalId);
            if (original?.posting.kind === "CUSTOMER_PAYMENT") {
              initialPaid = initialPaid.add(allocation.amount);
            } else {
              const collection = collections.get(payment.id) ?? {
                id: payment.id,
                date: original?.payment?.occurredAt ?? payment.occurredAt,
                reference: "বকেয়া জমা",
                description: payment.reference ?? "",
                kind: "payment" as const,
                debit: new Prisma.Decimal(0),
                credit: new Prisma.Decimal(0),
              };
              collection.credit = collection.credit.add(allocation.amount);
              collections.set(payment.id, collection);
            }
          }
          events.push({
            id: sale.id,
            date: sale.soldAt ?? sale.createdAt,
            reference: sale.invoiceNumber ?? "বিক্রি",
            description: "",
            kind: "sale",
            debit: sale.total,
            credit: initialPaid,
          });
          for (const returned of sale.returns) {
            events.push({
              id: returned.id,
              date: returned.postedAt,
              reference: sale.invoiceNumber ?? "পণ্য ফেরত",
              description: "পণ্য ফেরত",
              kind: "return",
              debit: returned.creditAmount.negated(),
              credit: new Prisma.Decimal(0),
            });
          }
        }
        events.push(...collections.values());
        // Keep independently posted opening balances or account adjustments meaningful.
        for (const entry of entries) {
          const original = originalJournal(entry.id);
          if (
            !original ||
            original.payment ||
            [
              "SALE_COMPLETE",
              "SALE",
              "SALES_RETURN",
              "SALE_RETURN",
              "TRANSACTION_REVERSAL",
            ].includes(original.posting.kind) ||
            original.posting.sourceCode.startsWith("sale:")
          )
            continue;
          const debit = entry.lines.reduce(
            (sum, line) => sum.add(line.debit),
            new Prisma.Decimal(0),
          );
          const credit = entry.lines.reduce(
            (sum, line) => sum.add(line.credit),
            new Prisma.Decimal(0),
          );
          events.push({
            id: entry.id,
            date: entry.postedAt,
            reference: "হিসাব সমন্বয়",
            description: "",
            kind: "adjustment",
            debit,
            credit,
          });
        }
        events.sort(
          (left, right) =>
            left.date.getTime() - right.date.getTime() ||
            Number(left.kind !== "sale") - Number(right.kind !== "sale") ||
            left.id.localeCompare(right.id),
        );
        let opening = new Prisma.Decimal(0);
        let debit = new Prisma.Decimal(0);
        let credit = new Prisma.Decimal(0);
        let balance = new Prisma.Decimal(0);
        const items: CustomerLedger["items"] = [];
        for (const event of events) {
          if (range && event.date >= range.end) continue;
          balance = balance.add(event.debit).sub(event.credit);
          if (range && event.date < range.start) {
            opening = balance;
            continue;
          }
          debit = debit.add(event.debit);
          credit = credit.add(event.credit);
          items.push({
            ...event,
            date: event.date.toISOString(),
            debit: event.debit.toFixed(2),
            credit: event.credit.toFixed(2),
            balance: balance.toFixed(2),
          });
        }
        const records = await customerRecords(tx, [customer]);
        const paymentAccounts = req.currentUser!.permissions.some((p) =>
          ["finance.write", "payments.customer"].includes(p),
        )
          ? await tx.account.findMany({
              where: {
                active: true,
                kind: "ASSET",
                paymentMethod: { not: null },
              },
              select: { id: true, name: true },
              orderBy: { code: "asc" },
            })
          : [];
        return {
          data: {
            customer: records[0],
            from: query.from ?? null,
            to: query.to ?? null,
            summary: {
              opening: opening.toFixed(2),
              debit: debit.toFixed(2),
              credit: credit.toFixed(2),
              closing: balance.toFixed(2),
            },
            paymentAccounts,
            items,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  @Post(":id/payments")
  async collectPayment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(validation(CollectCustomerPaymentDto))
    body: CollectCustomerPaymentDto,
    @Headers("idempotency-key") key: string,
    @Req() req: AuthRequest,
  ) {
    checkAccess(req);
    if (
      !req.currentUser!.permissions.some((p) =>
        ["finance.write", "payments.customer"].includes(p),
      )
    )
      throw new ForbiddenException(
        "You do not have permission to collect payments.",
      );
    if (!isUUID(key))
      throw new BadRequestException("A UUID Idempotency-Key is required.");
    businessRange(body.date, body.date);
    const amount = new Prisma.Decimal(body.amount);
    if (amount.lte(0))
      throw new BadRequestException("Enter an amount greater than zero.");
    const actorId = req.currentUser!.id;
    const operation = "CUSTOMER_DUE_COLLECTION";
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          id,
          body.date,
          amount.toFixed(2),
          body.paymentAccountId,
          body.reference ?? "",
        ]),
      )
      .digest("hex");
    const data = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actorId + ":" + operation + ":" + key}, 0))`;
        const prior = await tx.idempotencyRecord.findUnique({
          where: { actorId_operation_key: { actorId, operation, key } },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ConflictException(
              "This payment was already submitted with different details.",
            );
          const payment = await tx.payment.findUnique({
            where: { id: prior.sourceId },
            select: { reversal: { select: { id: true } } },
          });
          if (!payment || payment.reversal)
            throw new ConflictException(
              "This payment has been reversed. Refresh the ledger before recording a new payment.",
            );
          return prior.responseBody;
        }
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id=${id}::uuid FOR NO KEY UPDATE`;
        const customer = await tx.customer.findUnique({ where: { id } });
        if (!customer?.active)
          throw new BadRequestException("Select an active customer.");
        // Share sale row locks with transaction cancellation before allocating a collection.
        await tx.$queryRaw`SELECT id FROM "Sale" WHERE "customerId"=${id}::uuid ORDER BY id FOR UPDATE`;
        const totals = await tx.journalLine.aggregate({
          where: { customerId: id, account: { code: "1200" } },
          _sum: { debit: true, credit: true },
        });
        const due = (totals._sum.debit ?? new Prisma.Decimal(0)).sub(
          totals._sum.credit ?? 0,
        );
        if (amount.gt(due))
          throw new BadRequestException(
            "The amount exceeds the customer's current outstanding due.",
          );
        const account = await tx.account.findUnique({
          where: { id: body.paymentAccountId },
        });
        const receivable = await tx.account.findUnique({
          where: { code: "1200" },
        });
        if (
          !account?.active ||
          account.kind !== "ASSET" ||
          !account.paymentMethod ||
          !receivable?.active ||
          receivable.kind !== "ASSET"
        )
          throw new BadRequestException("Select an active payment account.");
        const sales = await tx.sale.findMany({
          where: { customerId: id, status: { in: [...postedSales] } },
          orderBy: [{ soldAt: "asc" }, { id: "asc" }],
          include: {
            returns: true,
            paymentAllocations: {
              where: {
                reversedAllocationId: null,
                reversal: { is: null },
                payment: { reversedPaymentId: null, reversal: { is: null } },
              },
            },
          },
        });
        let remaining = amount;
        const allocations: { saleId: string; amount: Prisma.Decimal }[] = [];
        for (const sale of sales) {
          const invoiceDue = sale.total
            .sub(
              sale.returns.reduce(
                (sum, item) => sum.add(item.creditAmount),
                new Prisma.Decimal(0),
              ),
            )
            .sub(
              sale.paymentAllocations.reduce(
                (sum, item) => sum.add(item.amount),
                new Prisma.Decimal(0),
              ),
            );
          const allocated = Prisma.Decimal.min(
            remaining,
            Prisma.Decimal.max(0, invoiceDue),
          );
          if (allocated.gt(0))
            allocations.push({ saleId: sale.id, amount: allocated });
          remaining = remaining.sub(allocated);
        }
        if (remaining.gt(0))
          throw new ConflictException(
            "The invoice balances have changed. Refresh the ledger and try again.",
          );
        const date = new Date(body.date + "T12:00:00+06:00");
        const posting = await tx.posting.create({
          data: {
            actorId,
            kind: operation,
            sourceCode: "customer-collection:" + key,
          },
        });
        const journal = await tx.journalEntry.create({
          data: {
            postingId: posting.id,
            postedAt: date,
            reason:
              "Due collection" + (body.reference ? " · " + body.reference : ""),
            lines: {
              create: [
                { accountId: account.id, debit: amount },
                { accountId: receivable.id, customerId: id, credit: amount },
              ],
            },
          },
        });
        const payment = await tx.payment.create({
          data: {
            number:
              "RCPT-" +
              key.slice(0, 8).toUpperCase() +
              key.slice(9, 13).toUpperCase(),
            direction: "INCOMING",
            amount,
            method: account.paymentMethod,
            reference: body.reference,
            occurredAt: date,
            customerId: id,
            assetAccountId: account.id,
            journalId: journal.id,
            allocations: { create: allocations },
          },
        });
        const result = {
          id: payment.id,
          number: payment.number,
          amount: amount.toFixed(2),
          due: due.sub(amount).toFixed(2),
        };
        await tx.auditLog.create({
          data: {
            actorId,
            action: operation,
            resourceType: "Payment",
            resourceId: payment.id,
            requestId: req.requestId,
            metadata: { customerId: id, amount: result.amount },
          },
        });
        await tx.idempotencyRecord.create({
          data: {
            actorId,
            operation,
            key,
            requestHash,
            sourceId: payment.id,
            responseStatus: 201,
            responseBody: result,
          },
        });
        return result;
      },
      { timeout: 15000 },
    );
    return { data };
  }

  @Get(":id/sales")
  async salesHistory(
    @Param("id", ParseUUIDPipe) id: string,
    @Query(validation(CustomerSalesQueryDto)) query: CustomerSalesQueryDto,
    @Req() req: AuthRequest,
  ) {
    checkAccess(req);
    const customer = await this.db.customer.findUnique({
      where: { id },
      select: customerFields,
    });
    if (!customer) throw new NotFoundException("Customer not found.");
    const where: Prisma.SaleWhereInput = {
      ...(query.saleId ? { id: query.saleId } : {}),
      customerId: id,
      status: { in: [...postedSales] },
    };
    const [rows, total] = await this.db.$transaction([
      this.db.sale.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ soldAt: "desc" }, { id: "desc" }],
        include: {
          items: {
            orderBy: { lineNumber: "asc" },
            include: {
              product: { select: { name: true, model: true, unit: true } },
            },
          },
        },
      }),
      this.db.sale.count({ where }),
    ]);
    return {
      data: {
        customer: (await customerRecords(this.db, [customer]))[0],
        total,
        page: query.page,
        pageSize: query.pageSize,
        items: rows.map((sale) => ({
          id: sale.id,
          invoiceNumber: sale.invoiceNumber,
          soldAt: sale.soldAt?.toISOString() ?? null,
          status: sale.status,
          subtotal: sale.subtotal.toFixed(2),
          discount: sale.discount.toFixed(2),
          total: sale.total.toFixed(2),
          products: sale.items.map((item) => {
            const snapshot =
              item.productSnapshot &&
              typeof item.productSnapshot === "object" &&
              !Array.isArray(item.productSnapshot)
                ? item.productSnapshot
                : {};
            const text = (key: string, fallback: string) =>
              typeof snapshot[key] === "string" ? snapshot[key] : fallback;
            return {
              id: item.id,
              name: text("name", item.product.name),
              model: text("model", item.product.model),
              unit: text("unit", item.product.unit),
              quantity: item.quantity.toString(),
              unitPrice: item.unitPrice.toFixed(2),
              amount: item.netRevenue.toFixed(2),
            };
          }),
        })),
      },
    };
  }

  @Get()
  async list(
    @Query(validation(CustomersQueryDto)) query: CustomersQueryDto,
    @Req() req: AuthRequest,
  ) {
    checkAccess(req);
    const [totalCustomers, activeCustomers, saleTotals, balances] =
      await this.db.$transaction([
        this.db.customer.count(),
        this.db.customer.count({ where: { active: true } }),
        this.db.sale.aggregate({
          where: { status: { in: [...postedSales] } },
          _sum: { total: true },
        }),
        this.db.journalLine.groupBy({
          by: ["customerId"],
          orderBy: { customerId: "asc" },
          where: { customerId: { not: null }, account: { code: "1200" } },
          _sum: { debit: true, credit: true },
        }),
      ]);
    const creditIds = balances
      .filter((balance) =>
        (balance._sum?.debit ?? new Prisma.Decimal(0)).gt(
          balance._sum?.credit ?? 0,
        ),
      )
      .map((balance) => balance.customerId!);
    const where: Prisma.CustomerWhereInput = {
      ...(query.status === "all" ? {} : { active: query.status === "active" }),
      ...(query.credit === "all"
        ? {}
        : {
            id:
              query.credit === "due" ? { in: creditIds } : { notIn: creditIds },
          }),
      ...(query.q
        ? {
            OR: [
              ...["name", "phone", "address"].map((field) => ({
                [field]: { contains: query.q, mode: "insensitive" },
              })),
            ],
          }
        : {}),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.customer.findMany({
        where,
        select: customerFields,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.customer.count({ where }),
    ]);
    return {
      data: {
        items: await customerRecords(this.db, rows),
        total,
        page: query.page,
        pageSize: query.pageSize,
        summary: {
          total: totalCustomers,
          active: activeCustomers,
          credit: creditIds.length,
          totalSales: (saleTotals._sum.total ?? new Prisma.Decimal(0)).toFixed(
            2,
          ),
          totalDue: balances
            .reduce(
              (sum, balance) =>
                sum.add(
                  Prisma.Decimal.max(
                    0,
                    (balance._sum?.debit ?? new Prisma.Decimal(0)).sub(
                      balance._sum?.credit ?? 0,
                    ),
                  ),
                ),
              new Prisma.Decimal(0),
            )
            .toFixed(2),
        },
      },
    };
  }

  @Post()
  async create(
    @Body(validation(CreateCustomerDto)) body: CreateCustomerDto,
    @Req() req: AuthRequest,
  ) {
    checkAccess(req);
    const customer = await nativeCreate(
      this.db,
      req,
      "MOBILE_CUSTOMER_CREATE",
      body,
      async (tx, id) => {
        const created = await tx.customer.create({
          data: {
            ...(id ? { id } : {}),
            name: body.name,
            phone: body.phone,
            address: body.address,
          },
          select: customerFields,
        });
        await tx.auditLog.create({
          data: {
            actorId: req.currentUser!.id,
            action: "CUSTOMER_CREATED",
            resourceType: "Customer",
            resourceId: created.id,
            requestId: req.requestId,
          },
        });
        return created;
      },
    );
    return {
      data: {
        ...customer,
        createdAt: customer.createdAt.toISOString(),
        totalSales: "0.00",
        due: "0.00",
      },
    };
  }
}
