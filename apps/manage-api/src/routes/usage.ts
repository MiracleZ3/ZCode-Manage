import { usageEventPageSchema, usageEventSchema, listUsageEventsQuerySchema } from "@zm/contracts";
import type { UsageEvent } from "@zm/contracts";
import type { Hono } from "hono";
import { encodeUsageCursor, type UsageEventRow } from "@zm/database";
import { parseQuery, type AuthEnv } from "@zm/shared";
import type { ManageServices } from "../services.js";
import { UsageCursorError } from "../services.js";

/** U1 用量明细：按时间倒序的键集分页。 */
export function registerUsageRoutes(app: Hono<AuthEnv>, services: ManageServices): void {
  app.get(
    "/em/v1/usage/events",
    services.auth.requireToken,
    services.auth.requireScope("usage:read"),
    async (c) => {
      const query = parseQuery(c, listUsageEventsQuerySchema);
      if (!query.ok) {
        return query.response;
      }
      let page;
      try {
        page = await services.listUsage(query.data);
      } catch (error) {
        if (error instanceof UsageCursorError) {
          return c.json(
            {
              error: {
                code: "validation_error",
                message: "invalid cursor",
                requestId: c.get("requestId"),
              },
            },
            400,
          );
        }
        throw error;
      }
      return c.json(
        usageEventPageSchema.parse({
          items: page.rows.map(toUsageEvent),
          nextCursor: page.nextCursor ? encodeUsageCursor(page.nextCursor) : null,
        }),
      );
    },
  );
}

function toUsageEvent(row: UsageEventRow): UsageEvent {
  return usageEventSchema.parse({
    id: row.id,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    clientId: row.clientId,
    model: row.model,
    upstreamModel: row.upstreamModel,
    endpointId: row.endpointId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    statusCode: row.statusCode,
    stream: row.stream === 1,
    durationMs: row.durationMs,
    usageSource: row.usageSource,
    errorKind: row.errorKind,
  });
}
