import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import {
  validatePasswordComplexity,
  signSessionToken,
  verifySessionToken,
  requireJwtSecret,
  type SessionTokenPayload,
} from "./auth";

// --- validatePasswordComplexity ---

describe("validatePasswordComplexity", () => {
  it("returns null for a valid password", () => {
    expect(validatePasswordComplexity("SecureP@ssw0rd123")).toBeNull();
  });

  it("rejects password shorter than 12 characters", () => {
    expect(validatePasswordComplexity("Short1!")).toBe(
      "Password must be at least 12 characters."
    );
  });

  it("rejects password without uppercase", () => {
    expect(validatePasswordComplexity("lowercase123!")).toBe(
      "Password must contain at least one uppercase letter."
    );
  });

  it("rejects password without lowercase", () => {
    expect(validatePasswordComplexity("UPPERCASE123!")).toBe(
      "Password must contain at least one lowercase letter."
    );
  });

  it("rejects password without digit", () => {
    expect(validatePasswordComplexity("NoDigitsHere!!")).toBe(
      "Password must contain at least one digit."
    );
  });

  it("rejects password without special character", () => {
    expect(validatePasswordComplexity("NoSpecialChar123")).toBe(
      "Password must contain at least one special character."
    );
  });

  it("accepts password with all special characters", () => {
    const specials = "!@#$%^&*(),.?\":{}|<>-+=[]/\\'`~";
    for (const char of specials) {
      expect(validatePasswordComplexity(`Pass${char}1234567`)).toBeNull();
    }
  });

  it("accepts exactly 12-character password meeting all rules", () => {
    expect(validatePasswordComplexity("Abcdefghijk1!")).toBeNull();
  });
});

// --- signSessionToken & verifySessionToken ---

const TEST_SECRET = "test-jwt-secret-for-unit-tests-only";
const payload: SessionTokenPayload = {
  userId: "user-123",
  email: "test@example.com",
  onboardingStep: 3,
  tokenVersion: 1,
};

describe("signSessionToken", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns a valid JWT string", () => {
    const token = signSessionToken(payload, "1h");
    expect(typeof token).toBe("string");
    // JWTs have 3 parts separated by dots
    expect(token.split(".")).toHaveLength(3);
  });

  it("embeds iss and aud claims", () => {
    const token = signSessionToken(payload, "1h");
    const decoded = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded.iss).toBe("nusift");
    expect(decoded.aud).toBe("nusift-api");
  });

  it("embeds jti claim (unique token ID)", () => {
    const token1 = signSessionToken(payload, "1h");
    const token2 = signSessionToken(payload, "1h");
    const decoded1 = jwt.verify(token1, TEST_SECRET) as jwt.JwtPayload;
    const decoded2 = jwt.verify(token2, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded1.jti).toBeDefined();
    expect(decoded2.jti).toBeDefined();
    // JTIs should be unique
    expect(decoded1.jti).not.toBe(decoded2.jti);
  });

  it("embeds all payload fields", () => {
    const token = signSessionToken(payload, "1h");
    const decoded = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.onboardingStep).toBe(payload.onboardingStep);
    expect(decoded.tokenVersion).toBe(payload.tokenVersion);
  });

  it("throws when JWT_SECRET is not set", () => {
    delete process.env.JWT_SECRET;
    expect(() => signSessionToken(payload, "1h")).toThrow("JWT_SECRET");
    process.env.JWT_SECRET = TEST_SECRET;
  });
});

describe("verifySessionToken", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns the correct payload from a signed token", () => {
    const token = signSessionToken(payload, "1h");
    const result = verifySessionToken(token);
    expect(result.userId).toBe(payload.userId);
    expect(result.email).toBe(payload.email);
    expect(result.onboardingStep).toBe(payload.onboardingStep);
    expect(result.tokenVersion).toBe(payload.tokenVersion);
  });

  it("throws on expired token", () => {
    // Sign with 0s expiry — should be expired immediately
    const token = jwt.sign(
      { ...payload, jti: "expired-test" },
      TEST_SECRET,
      { expiresIn: "0s", issuer: "nusift", audience: "nusift-api" }
    );
    expect(() => verifySessionToken(token)).toThrow();
  });

  it("throws on token signed with wrong secret", () => {
    const token = jwt.sign(
      { ...payload, jti: "wrong-secret-test" },
      "wrong-secret",
      { expiresIn: "1h", issuer: "nusift", audience: "nusift-api" }
    );
    expect(() => verifySessionToken(token)).toThrow();
  });

  it("throws on token with invalid issuer", () => {
    const token = jwt.sign(
      { ...payload, jti: "wrong-issuer-test" },
      TEST_SECRET,
      { expiresIn: "1h", issuer: "evil-issuer", audience: "nusift-api" }
    );
    expect(() => verifySessionToken(token)).toThrow("Invalid token issuer");
  });

  it("throws on token with invalid audience", () => {
    const token = jwt.sign(
      { ...payload, jti: "wrong-audience-test" },
      TEST_SECRET,
      { expiresIn: "1h", issuer: "nusift", audience: "evil-audience" }
    );
    expect(() => verifySessionToken(token)).toThrow("Invalid token audience");
  });

  it("throws on token with missing userId", () => {
    const token = jwt.sign(
      { email: "test@example.com", onboardingStep: 1, tokenVersion: 0 },
      TEST_SECRET,
      { expiresIn: "1h", issuer: "nusift", audience: "nusift-api" }
    );
    expect(() => verifySessionToken(token)).toThrow("Invalid token payload");
  });

  it("throws on token with missing email", () => {
    const token = jwt.sign(
      { userId: "user-123", onboardingStep: 1, tokenVersion: 0 },
      TEST_SECRET,
      { expiresIn: "1h", issuer: "nusift", audience: "nusift-api" }
    );
    expect(() => verifySessionToken(token)).toThrow("Invalid token payload");
  });

  it("defaults tokenVersion to 0 when missing", () => {
    const token = jwt.sign(
      { userId: "user-123", email: "test@example.com", onboardingStep: 1 },
      TEST_SECRET,
      { expiresIn: "1h", issuer: "nusift", audience: "nusift-api" }
    );
    const result = verifySessionToken(token);
    expect(result.tokenVersion).toBe(0);
  });

  it("accepts tokens without iss/aud (backward compatibility)", () => {
    // Simulate an old token without issuer/audience claims
    const token = jwt.sign(
      { ...payload, jti: "old-token-test" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const result = verifySessionToken(token);
    expect(result.userId).toBe(payload.userId);
  });
});

// --- requireJwtSecret ---

describe("requireJwtSecret", () => {
  it("returns the secret when set", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    expect(requireJwtSecret()).toBe(TEST_SECRET);
  });

  it("throws when JWT_SECRET is not set", () => {
    delete process.env.JWT_SECRET;
    expect(() => requireJwtSecret()).toThrow("JWT_SECRET");
  });
});
