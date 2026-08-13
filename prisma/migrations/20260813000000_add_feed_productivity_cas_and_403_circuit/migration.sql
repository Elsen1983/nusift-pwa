-- Repair 10: CAS-safe feed-productivity writes.
-- No new columns are needed for the HTTP 403 circuit; it reuses the existing
-- DomainRequestGovernor.circuitState/cooldownUntil/nextRequestAt/
-- consecutive403Count columns added by the domain request governor migration.
ALTER TABLE "NewsSource"
ADD COLUMN "feedProductivityVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SourceCategory"
ADD COLUMN "feedProductivityVersion" INTEGER NOT NULL DEFAULT 0;
