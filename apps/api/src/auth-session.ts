import type { PrismaClient } from "@prisma/client";

type SessionIdentity = {
  deviceSession: boolean;
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userId: string;
  name: string;
  login: string;
  active: boolean;
  passwordChangedAt: Date;
  roles: string[];
  permissions: string[];
};

// Read current grants on every request in one database round trip. Never cache
// authorization across requests: revocations and permission changes apply at once.
export async function readSessionIdentity(
  db: Pick<PrismaClient, "$queryRaw">,
  tokenHash: string,
) {
  const rows = await db.$queryRaw<SessionIdentity[]>`
    SELECT s."id", s."createdAt", s."lastSeenAt", s."expiresAt", s."revokedAt", s."deviceSession",
      u."id" AS "userId", u."name", u."login", u."active", u."passwordChangedAt",
      COALESCE(array_agg(DISTINCT r."code" ORDER BY r."code")
        FILTER (WHERE r."code" IS NOT NULL), ARRAY[]::text[]) AS "roles",
      COALESCE(array_agg(DISTINCT p."code" ORDER BY p."code")
        FILTER (WHERE p."code" IS NOT NULL), ARRAY[]::text[]) AS "permissions"
    FROM "Session" s
    JOIN "User" u ON u."id" = s."userId"
    LEFT JOIN "UserRole" ur ON ur."userId" = u."id"
    LEFT JOIN "Role" r ON r."id" = ur."roleId"
    LEFT JOIN "RolePermission" rp ON rp."roleId" = r."id"
    LEFT JOIN "Permission" p ON p."id" = rp."permissionId"
    WHERE s."tokenHash" = ${tokenHash}
    GROUP BY s."id", u."id"
  `;
  return rows[0] ?? null;
}
