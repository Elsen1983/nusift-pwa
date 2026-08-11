-- Forward-only durable, bounded robots policy cache.
-- The rules column stores parsed bounded directives only; raw robots bodies
-- and request metadata are intentionally not persisted.
CREATE TABLE "PublisherRobotsPolicy" (
    "domainKey" TEXT NOT NULL,
    "policyStatus" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "httpStatus" INTEGER,
    "lastDecision" TEXT,
    "lastDecisionAt" TIMESTAMP(3),
    "activeLeaseToken" TEXT,
    "activeLeaseExpiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublisherRobotsPolicy_pkey" PRIMARY KEY ("domainKey")
);

CREATE INDEX "PublisherRobotsPolicy_expiresAt_idx"
    ON "PublisherRobotsPolicy"("expiresAt");

CREATE INDEX "PublisherRobotsPolicy_activeLeaseExpiresAt_idx"
    ON "PublisherRobotsPolicy"("activeLeaseExpiresAt");
