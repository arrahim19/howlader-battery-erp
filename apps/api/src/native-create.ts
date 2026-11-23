import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { isUUID } from "class-validator";
import { type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
/** Client-created UUIDs keep offline contacts/products usable by later queued
 * transactions. The write and its replay receipt commit in one transaction. */
export function nativeCreate<T>(
  db: DatabaseService,
  req: AuthRequest,
  operation: string,
  body: unknown,
  work: (tx: Prisma.TransactionClient, id?: string) => Promise<T>,
): Promise<T> {
  const key =
    req.authTransport === "bearer" ? req.headers["idempotency-key"] : undefined;
  if (!key) return db.$transaction((tx) => work(tx));
  if (typeof key !== "string" || !isUUID(key))
    throw new BadRequestException("A UUID Idempotency-Key is required.");
  const actorId = req.currentUser!.id,
    hash = createHash("sha256")
      .update(JSON.stringify(stable(body)))
      .digest("hex");
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actorId}:${operation}:${key}`},0))::text`;
      const saved = await tx.idempotencyRecord.findUnique({
        where: { actorId_operation_key: { actorId, operation, key } },
      });
      if (saved) {
        if (saved.requestHash !== hash)
          throw new ConflictException(
            "This operation was already saved with different data.",
          );
        return JSON.parse(JSON.stringify(saved.responseBody), (k, v) =>
          /^(createdAt|updatedAt)$/.test(k) && typeof v === "string"
            ? new Date(v)
            : /^(defaultSellingPrice|lowStockThreshold|unitCost|capacityAh|voltage)$/.test(
                  k,
                ) && typeof v === "string"
              ? new Prisma.Decimal(v)
              : v,
        ) as T;
      }
      const value = await work(tx, key);
      await tx.idempotencyRecord.create({
        data: {
          operation,
          key,
          actorId,
          requestHash: hash,
          responseStatus: 201,
          responseBody: JSON.parse(
            JSON.stringify(value),
          ) as Prisma.InputJsonValue,
          sourceId: key,
        },
      });
      return value;
    },
    { timeout: 30000 },
  );
}
