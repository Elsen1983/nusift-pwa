import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import {
  INSPECTION_SNAPSHOT_TTL_MS,
  InspectionSnapshotValidationError,
  buildTargetFingerprint,
  createInspectionSnapshotToken,
  inspectionSnapshotSummaryFromClaims,
  parseInspectionSnapshotToken,
} from "./inspection-snapshot";
import type { InspectionActiveTargetResolution } from "./inspection-active-targets";

const SECRET = "snapshot-test-secret";

const resolution = (overrides: Partial<InspectionActiveTargetResolution> = {}): InspectionActiveTargetResolution => ({
  sourceIds: ["s-1", "s-2"],
  categoryIds: ["c-1"],
  targets: [],
  sourceScanned: 2,
  categoryScanned: 1,
  sourceTruncated: false,
  categoryTruncated: false,
  artifactEvidenceTruncated: false,
  truncated: false,
  targetType: "ALL",
  snapshotId: "abc",
  filterFingerprint: buildTargetFingerprint("ALL"),
  ...overrides,
});

describe("inspection snapshot token", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("round-trips a signed token and reports a truthful summary", () => {
    const token = createInspectionSnapshotToken(resolution());
    const claims = parseInspectionSnapshotToken(token, "ALL", buildTargetFingerprint("ALL"));
    expect(claims.sourceIds).toEqual(["s-1", "s-2"]);
    expect(claims.categoryIds).toEqual(["c-1"]);
    expect(claims.version).toBe(1);
    const summary = inspectionSnapshotSummaryFromClaims(claims);
    expect(summary.sourceCount).toBe(2);
    expect(summary.categoryCount).toBe(1);
    expect(summary.truncated).toBe(false);
    expect(Date.parse(summary.expiresAt) - Date.parse(summary.generatedAt)).toBe(INSPECTION_SNAPSHOT_TTL_MS);
    expect(claims.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deduplicates and bounds IDs without failing", () => {
    const token = createInspectionSnapshotToken(resolution({
      sourceIds: ["s-1", "s-1", "dup!" as any, "x".repeat(200), ...Array.from({ length: 1_200 }, (_, index) => `s-${index}`)],
    }));
    const claims = parseInspectionSnapshotToken(token, "ALL", buildTargetFingerprint("ALL"));
    expect(claims.sourceIds.length).toBeLessThanOrEqual(1_000);
    expect(new Set(claims.sourceIds).size).toBe(claims.sourceIds.length);
  });

  it("rejects a token with the wrong target type", () => {
    const token = createInspectionSnapshotToken(resolution({ targetType: "SOURCE" as const, filterFingerprint: buildTargetFingerprint("SOURCE") }));
    expect(() => parseInspectionSnapshotToken(token, "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
  });

  it("rejects a token with a different active-target fingerprint", () => {
    const token = createInspectionSnapshotToken(resolution({ targetType: "ALL" as const, filterFingerprint: buildTargetFingerprint("ALL") }));
    expect(() => parseInspectionSnapshotToken(token, "ALL", JSON.stringify({ version: 1, targetType: "CATEGORY" }))).toThrow(InspectionSnapshotValidationError);
  });

  it("rejects a malformed token", () => {
    expect(() => parseInspectionSnapshotToken("not-a-jwt", "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
    expect(() => parseInspectionSnapshotToken("", "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
    expect(() => parseInspectionSnapshotToken(null, "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
  });

  it("rejects a token signed with the wrong secret", () => {
    const forged = jwt.sign({ ...resolution(), contentHash: "x" }, "attacker-secret", { expiresIn: "10m" });
    expect(() => parseInspectionSnapshotToken(forged, "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
  });

  it("rejects a modified token even with a valid signature", () => {
    const token = createInspectionSnapshotToken(resolution());
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    // Re-sign the tampered payload with the valid secret: the signature is
    // valid but the explicit content hash no longer matches the payload, so
    // the modification must be detected by the hash check.
    for (const claim of ["iat", "exp", "nbf", "aud", "iss", "jti"]) delete payload[claim];
    payload.sourceIds = ["attacker-controlled-id"];
    const modified = jwt.sign(payload, SECRET, {
      expiresIn: "10m",
      issuer: "nusift-admin-inspection",
      audience: "nusift-admin-inspection",
    });
    expect(() => parseInspectionSnapshotToken(modified, "ALL", buildTargetFingerprint("ALL"))).toThrow("modified");
  });

  it("rejects an expired token", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const token = createInspectionSnapshotToken(resolution(), past);
    expect(() => parseInspectionSnapshotToken(token, "ALL", buildTargetFingerprint("ALL"))).toThrow("expired");
  });

  it("rejects an unsupported version", () => {
    const token = createInspectionSnapshotToken(resolution());
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    for (const claim of ["iat", "exp", "nbf", "aud", "iss", "jti"]) delete payload[claim];
    payload.version = 99;
    payload.contentHash = "recomputed";
    const signed = jwt.sign(payload, SECRET, { issuer: "nusift-admin-inspection", audience: "nusift-admin-inspection", expiresIn: "10m" });
    expect(() => parseInspectionSnapshotToken(signed, "ALL", buildTargetFingerprint("ALL"))).toThrow("version");
  });

  it("rejects a token for a different audience/issuer", () => {
    const forged = jwt.sign({ ...resolution(), contentHash: "x" }, SECRET, { expiresIn: "10m" });
    expect(() => parseInspectionSnapshotToken(forged, "ALL", buildTargetFingerprint("ALL"))).toThrow(InspectionSnapshotValidationError);
  });
});
