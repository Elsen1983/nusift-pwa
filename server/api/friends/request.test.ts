import { describe, it, expect } from "vitest";

/**
 * Regression tests for the friend-request guard logic.
 *
 * The actual handler depends on h3, Prisma, and Nitro runtime helpers so we
 * test the guard *logic* in isolation: given an `existing` connection record,
 * verify which status codes / messages the handler would produce.
 *
 * This mirrors the conditional block in `request.post.ts`:
 *   if (addressee.id === requesterId)              → 400
 *   if (existing?.status === "PENDING")             → 409
 *   if (existing?.status === "ACCEPTED")            → 409
 *   if (existing?.status === "BLOCKED")             → 409
 *   otherwise                                       → proceed (create / upsert)
 */

type ConnectionStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "BLOCKED";

interface ExistingConnection {
  id: string;
  status: ConnectionStatus;
}

function evaluateGuards(params: {
  requesterId: string;
  addresseeId: string;
  existing: ExistingConnection | null;
}): { allowed: boolean; statusCode?: number; message?: string } {
  const { requesterId, addresseeId, existing } = params;

  // Self-invite
  if (addresseeId === requesterId) {
    return { allowed: false, statusCode: 400, message: "You cannot add yourself as a friend." };
  }

  // Existing connection checks
  if (existing?.status === "PENDING") {
    return { allowed: false, statusCode: 409, message: "A friend request is already pending." };
  }

  if (existing?.status === "ACCEPTED") {
    return { allowed: false, statusCode: 409, message: "You are already friends." };
  }

  if (existing?.status === "BLOCKED") {
    return { allowed: false, statusCode: 409, message: "This connection is blocked." };
  }

  // No blocking condition — request can proceed
  return { allowed: true };
}

// ---- Tests ----

describe("friend-request guards", () => {
  const USER_A = "a0000000-0000-0000-0000-000000000001";
  const USER_B = "b0000000-0000-0000-0000-000000000002";

  it("blocks self-invite with 400", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_A,
      existing: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  it("blocks when connection is PENDING with 409", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_B,
      existing: { id: "conn-1", status: "PENDING" },
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.message).toContain("pending");
  });

  it("blocks when connection is ACCEPTED with 409", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_B,
      existing: { id: "conn-2", status: "ACCEPTED" },
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.message).toContain("already friends");
  });

  it("blocks when connection is BLOCKED with 409", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_B,
      existing: { id: "conn-3", status: "BLOCKED" },
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.message).toContain("blocked");
  });

  it("allows when connection is DECLINED (re-request)", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_B,
      existing: { id: "conn-4", status: "DECLINED" },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows when no prior connection exists", () => {
    const result = evaluateGuards({
      requesterId: USER_A,
      addresseeId: USER_B,
      existing: null,
    });
    expect(result.allowed).toBe(true);
  });
});
