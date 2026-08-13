-- Repair 13: bounded ETag/Last-Modified conditional-request memory.
-- No raw HTML/XML is stored; parsedPayload holds only the minimum result
-- needed to reconstruct a truthful 304 response for the owning caller.
CREATE TABLE "HttpValidatorCache" (
    "resourceKey" TEXT NOT NULL,
    "resourceClass" TEXT NOT NULL,
    "etag" TEXT,
    "lastModified" TEXT,
    "parsedPayload" JSONB NOT NULL,
    "payloadBytes" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHttpStatus" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HttpValidatorCache_pkey" PRIMARY KEY ("resourceKey")
);

CREATE INDEX "HttpValidatorCache_resourceClass_expiresAt_idx"
    ON "HttpValidatorCache"("resourceClass", "expiresAt");

CREATE INDEX "HttpValidatorCache_expiresAt_idx"
    ON "HttpValidatorCache"("expiresAt");
