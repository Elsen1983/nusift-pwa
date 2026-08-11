-- Prompt 17B: durable, hostname-keyed domain request governor state.
-- No URLs, response bodies, cookies, headers, article text, or user data are stored.
CREATE TABLE "DomainRequestGovernor" (
    "domainKey" TEXT NOT NULL,
    "circuitState" TEXT NOT NULL DEFAULT 'CLOSED',
    "cooldownUntil" TIMESTAMP(3),
    "nextRequestAt" TIMESTAMP(3),
    "activeLeaseToken" TEXT,
    "activeLeaseExpiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "consecutive429Count" INTEGER NOT NULL DEFAULT 0,
    "consecutive403Count" INTEGER NOT NULL DEFAULT 0,
    "lastHttpStatus" INTEGER,
    "lastSuccessAt" TIMESTAMP(3),
    "lastBlockedAt" TIMESTAMP(3),
    "lastDecision" TEXT,
    "lastDecisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainRequestGovernor_pkey" PRIMARY KEY ("domainKey")
);

CREATE INDEX "DomainRequestGovernor_activeLeaseExpiresAt_idx"
    ON "DomainRequestGovernor"("activeLeaseExpiresAt");

CREATE INDEX "DomainRequestGovernor_circuitState_cooldownUntil_idx"
    ON "DomainRequestGovernor"("circuitState", "cooldownUntil");

CREATE INDEX "DomainRequestGovernor_nextRequestAt_idx"
    ON "DomainRequestGovernor"("nextRequestAt");
