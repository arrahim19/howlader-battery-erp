ALTER TABLE "User" ADD COLUMN "email" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "AccountEmailToken" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "userId" UUID NOT NULL,
    CONSTRAINT "AccountEmailToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccountEmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountEmailToken_purpose_check" CHECK ("purpose" IN ('VERIFY_EMAIL', 'RESET_PASSWORD'))
);
CREATE UNIQUE INDEX "AccountEmailToken_tokenHash_key" ON "AccountEmailToken"("tokenHash");
CREATE UNIQUE INDEX "AccountEmailToken_userId_purpose_key" ON "AccountEmailToken"("userId", "purpose");
CREATE INDEX "AccountEmailToken_expiresAt_idx" ON "AccountEmailToken"("expiresAt");
