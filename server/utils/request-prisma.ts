import { prisma as globalPrisma } from "./prisma";

/**
 * Request-scoped Prisma resolution (Prompt 13G).
 *
 * Why request-scoped Prisma is retained for the admin-inspection endpoints:
 * - `/api/dev/*` inspection handlers are ADMIN-only dev endpoints whose query
 *   logic must be executable against an isolated, randomized PostgreSQL schema
 *   in the application-level integration suite. Passing the isolated client
 *   through `event.context.prisma` is the only supported injection path.
 * - The production user-feed endpoint does NOT use this helper anymore: it
 *   calls the shared user-feed service with the process-global Prisma client
 *   (see server/api/feed.ts and server/services/user-feed.ts), so normal
 *   production requests retain their previous global-client behavior.
 *
 * Security contract:
 * - ONLY the server-created `event.context` object can supply the override.
 *   Client-controlled inputs (query parameters, body fields, headers) are
 *   never read here and no middleware copies them into `event.context.prisma`.
 * - Only an object value is accepted; primitives, strings and null fall back
 *   to the global client. `event.context` itself is populated exclusively by
 *   Nuxt server code (auth/session middleware), never by request payloads.
 */
export function getRequestPrisma(event: { context?: Record<string, unknown> }) {
  const candidate = event.context?.prisma;
  // Only a plain object (never an array, string, number or null) is accepted.
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as typeof globalPrisma : globalPrisma;
}
