import jwt from "jsonwebtoken";
import { createError, setCookie, type H3Event } from "h3";

export interface SessionTokenPayload {
  userId: string;
  email: string;
  onboardingStep: number;
  tokenVersion: number;
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
  return jwt.sign(payload, requireJwtSecret(), { expiresIn });
}

export function verifySessionToken(token: string): SessionTokenPayload {
  const decoded = jwt.verify(token, requireJwtSecret());
  if (!decoded || typeof decoded !== "object") {
    throw createError({ statusCode: 401, statusMessage: "Invalid token." });
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
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  });
}
