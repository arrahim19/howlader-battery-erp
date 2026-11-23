-- Shared routing metadata only. Existing records stay in public.
CREATE TABLE "Shop" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "branchName" TEXT NOT NULL,
  "schemaName" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Shop_branchName_key" ON "Shop"("branchName");
CREATE UNIQUE INDEX "Shop_schemaName_key" ON "Shop"("schemaName");
INSERT INTO "Shop" ("id", "name", "branchName", "schemaName")
VALUES ('00000000-0000-4000-8000-000000000001',
  COALESCE((SELECT "value"->>'name' FROM "ApplicationSetting" WHERE "key"='shop'), 'Hawlader Battery House'),
  'Betagi', 'public');
