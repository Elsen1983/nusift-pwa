import { createError, readBody } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import {
  inspectNotificationWorkflowMarkers,
  reconcileNotificationWorkflowMarker,
} from "../../utils/news-pipeline/notification-workflow-reconciliation";

const MAX_DATE_KEY_LENGTH = 10;

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "notification-workflow-reconcile", 5, 60 * 1000);

  let body: {
    markerRunId?: string;
    dateKey?: string;
    confirm?: boolean;
    confirmation?: string;
    action?: "acknowledge" | "abandon";
  } = {};
  try {
    body = await readBody(event);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid JSON body." });
  }

  if (body.markerRunId) {
    if (body.markerRunId.length > 100) {
      throw createError({ statusCode: 400, statusMessage: "Invalid marker ID." });
    }
    if (body.confirm === true) {
      return reconcileNotificationWorkflowMarker({
        markerRunId: body.markerRunId,
        confirmation: body.confirmation,
        action: body.action,
      });
    }
    const markers = await inspectNotificationWorkflowMarkers({ dateKey: body.dateKey });
    return {
      ok: true,
      readOnly: true,
      markers: markers.filter((marker) => marker.id === body.markerRunId),
    };
  }

  if (body.dateKey !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(body.dateKey) || body.dateKey.length !== MAX_DATE_KEY_LENGTH)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid UTC date key." });
  }
  return {
    ok: true,
    readOnly: true,
    markers: await inspectNotificationWorkflowMarkers({ dateKey: body.dateKey }),
  };
});
