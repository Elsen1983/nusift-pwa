import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createError, setCookie, type H3Event } from "h3";

const TOKEN_ISSUER = "nusift";
const TOKEN_AUDIENCE = "nusift-api";

export interface SessionTokenPayload {
  userId: string;
  email: string;
  onboardingStep: number;
  tokenVersion: number;
  jti?: string;
  // Token revocation is handled via tokenVersion (incremented on password reset).
  // This invalidates ALL sessions for the user — simple, no DB overhead, sufficient
  // for this app's threat model. See session-guard.ts for enforcement.
}

export function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw createError({
      statusCode: 500,
      statusMessage: "JWT_SECRET is not configured.",
    });
  }
  return secret;
}

export function signSessionToken(payload: SessionTokenPayload, expiresIn: string) {
  const secret = requireJwtSecret();
  const tokenPayload: jwt.JwtPayload = { ...payload, jti: crypto.randomUUID() };
  return jwt.sign(tokenPayload, secret, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  } as jwt.SignOptions);
}

export function verifySessionToken(token: string): SessionTokenPayload {
  const decoded = jwt.verify(token, requireJwtSecret());
  if (!decoded || typeof decoded !== "object") {
    throw createError({ statusCode: 401, statusMessage: "Invalid token." });
  }

  // Validate iss/aud if present (backward-compatible: old tokens without these claims still pass).
  // Once all existing tokens have rotated through (≤7d), this can become strict validation.
  const d = decoded as Record<string, unknown>;
  if ("iss" in d && d.iss !== TOKEN_ISSUER) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token issuer." });
  }
  if ("aud" in d && d.aud !== TOKEN_AUDIENCE) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token audience." });
  }

  const payload = decoded as Partial<SessionTokenPayload>;
  if (
    !payload.userId ||
    !payload.email ||
    typeof payload.onboardingStep !== "number"
  ) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token payload." });
  }

  return {
    userId: payload.userId,
    email: payload.email,
    onboardingStep: payload.onboardingStep,
    tokenVersion: typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0,
  };
}

export function setSessionCookies(event: H3Event, token: string, maxAge: number) {
  setCookie(event, "auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  });

  setCookie(event, "session_status", "active", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  });
}
