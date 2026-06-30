import { createError, readBody } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";

export default defineEventHandler(async (event) => {
  const requesterId = await requireUserId(event);
  await assertRateLimit(event, "friends-request", 10, 60 * 60 * 1000);
  const body = await readBody(event);
  const target = typeof body?.target === "string" ? body.target.trim() : "";

  if (!target) {
    throw createError({ statusCode: 400, statusMessage: "Target email or nickname is required." });
  }

  const isEmail = target.includes("@");
  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    select: {
      id: true,
      email: true,
      profile: { select: { nickname: true } },
    },
  });

  const addressee = await prisma.user.findFirst({
    where: isEmail
      ? { email: { equals: target, mode: "insensitive" } }
      : { profile: { nickname: { equals: target, mode: "insensitive" } } },
    select: {
      id: true,
      email: true,
      profile: { select: { nickname: true, firstName: true, lastName: true } },
    },
  });

  if (!addressee) {
    throw createError({ statusCode: 404, statusMessage: "User not found." });
  }

  if (addressee.id === requesterId) {
    throw createError({ statusCode: 400, statusMessage: "You cannot add yourself as a friend." });
  }

  const existing = await prisma.usersConnection.findFirst({
    where: {
      OR: [
        { requesterId, addresseeId: addressee.id },
        { requesterId: addressee.id, addresseeId: requesterId },
      ],
    },
    select: { id: true, status: true },
  });

  if (existing?.status === "PENDING") {
    throw createError({ statusCode: 409, statusMessage: "A friend request is already pending." });
  }

  if (existing?.status === "ACCEPTED") {
    throw createError({ statusCode: 409, statusMessage: "You are already friends." });
  }

  if (existing?.status === "BLOCKED") {
    throw createError({ statusCode: 409, statusMessage: "This connection is blocked." });
  }

  const [connection] = await prisma.$transaction([
    prisma.usersConnection.upsert({
      where: { requesterId_addresseeId: { requesterId, addresseeId: addressee.id } },
      create: { requesterId, addresseeId: addressee.id, status: "PENDING" },
      update: { status: "PENDING" },
    }),
  ]);

  await prisma.notification.create({
    data: {
      userId: addressee.id,
      type: "FRIEND_REQUEST",
      title: "New friend request",
      body: `You received a friend request from ${requester?.profile?.nickname ? `@${requester.profile.nickname}` : requester?.email || "a user"}.`,
      url: "/notifications",
      payload: {
        connectionId: connection.id,
        requesterId,
        requester: {
          id: requesterId,
        },
      },
      status: "SENT",
      sentAt: new Date(),
    },
  });

  return { ok: true, connectionId: connection.id };
});
