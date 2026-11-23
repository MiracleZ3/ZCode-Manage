import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiErrorSchema,
  chatCompletionRequestMetaSchema,
  openAiModelListSchema,
  type ErrorCode,
  type TokenUsage,
  type UsageErrorKind,
} from "@zm/contracts";
import type { UsageEventInput } from "@zm/database";
import { createBaseApp, getClaims, type AuthEnv, type Logger } from "@zm/shared";
import { ZM_VERSION } from "./build-time.js";
import { classifyOutcome, forwardToUpstream, pickUsageSource } from "./proxy.js";
import type { GatewayServices } from "./services.js";

export const SERVICE_NAME = "model-gateway";

const MODEL_INVOKE_SCOPE = "model:invoke";

/** 一次调用里与上游结果无关的事实；上游结果出来后再补全成一条用量。 */
interface UsageDraft {
  input: Omit<
    UsageEventInput,
    | "statusCode"
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "durationMs"
    | "usageSource"
    | "errorKind"
  >;
  startedAt: number;
}

interface Outcome {
  statusCode: number;
  usage?: TokenUsage;
  errorKind: UsageErrorKind | null;
}

export interface GatewayApp {
  app: Hono<AuthEnv>;
  /** 等所有尚未落库的用量写完。测试和优雅退出时用。 */
  idle: () => Promise<void>;
}

export function createGatewayApp(services: GatewayServices): GatewayApp {
  const app = createBaseApp<AuthEnv>({
    service: SERVICE_NAME,
    version: ZM_VERSION,
    logger: services.logger,
  });
  const pending = new Set<Promise<unknown>>();

  const settle = (draft: UsageDraft, outcome: Outcome): Promise<unknown> =>
    services.recordUsage({
      ...draft.input,
      statusCode: outcome.statusCode,
      inputTokens: outcome.usage?.prompt_tokens ?? null,
      outputTokens: outcome.usage?.completion_tokens ?? null,
      totalTokens: outcome.usage?.total_tokens ?? null,
      durationMs: Math.round(performance.now() - draft.startedAt),
      usageSource: pickUsageSource(outcome.usage),
      errorKind: outcome.errorKind,
    });

  /** 把一个后台写入登记下来；失败只记日志，不影响已经发给客户端的响应。 */
  const track = (promise: Promise<unknown>, logger: Logger): void => {
    pending.add(promise);
    void promise
      .catch((error: unknown) => logger.error(undefined, "usage recording failed", error))
      .finally(() => pending.delete(promise));
  };

  app.post(
    "/gateway/v1/chat/completions",
    services.auth.requireToken,
    services.auth.requireScope(MODEL_INVOKE_SCOPE),
    async (c) => {
      const startedAt = performance.now();
      const raw: unknown = await c.req.json().catch(() => undefined);
      const meta = chatCompletionRequestMetaSchema.safeParse(raw);
      if (!meta.success) {
        return gatewayError(
          c,
          400,
          "validation_error",
          "Request body is not a Chat Completions request",
        );
      }
      // 模型不存在时不触达上游，也不记用量：请求还没有发生。
      const model = await services.findModel(meta.data.model);
      if (!model) {
        return gatewayError(c, 404, "model_not_found", `Model not found: ${meta.data.model}`);
      }

      const claims = getClaims(c);
      const draft: UsageDraft = {
        startedAt,
        input: {
          // 幂等键由网关生成，不用调用方给的请求 ID：同一个请求 ID 可能被重用。
          requestId: randomUUID(),
          subjectType: claims["zm:accountType"],
          subjectId: claims.sub,
          subjectName: claims["zm:displayName"],
          clientId: claims.client_id,
          model: model.model.id,
          upstreamModel: model.model.upstreamModel,
          endpointId: model.endpoint.id,
          stream: meta.data.stream ? 1 : 0,
        },
      };

      const result = await forwardToUpstream(
        {
          endpoint: model.endpoint,
          // 客户端用的是目录里的模型名；上游只认识它自己的名字，所以改写 model 字段，其余不动。
          body: { ...(raw as Record<string, unknown>), model: model.model.upstreamModel },
          stream: meta.data.stream,
        },
        {
          fetchFn: services.fetchFn,
          timeoutMs: services.config.upstreamTimeoutMs,
          env: services.env,
        },
      );
      if (!result.ok) {
        await settle(draft, { statusCode: 502, errorKind: "network_error" });
        return gatewayError(c, 502, "upstream_error", "Upstream is unreachable");
      }

      const errorKind = classifyOutcome(result.status, false);
      if (!meta.data.stream) {
        // 非流式：用量在返回前已经确定。写完再返回，调用方拿到响应时库里的明细已经成立。
        await settle(draft, { statusCode: result.status, usage: await result.usage, errorKind });
        return result.response;
      }

      // 流式：先把响应交出去，流结束后再写用量。
      track(
        result.usage.then((usage) =>
          settle(draft, { statusCode: result.status, usage, errorKind }),
        ),
        services.logger,
      );
      return result.response;
    },
  );

  app.get(
    "/gateway/v1/models",
    services.auth.requireToken,
    services.auth.requireScope(MODEL_INVOKE_SCOPE),
    async (c) => {
      const models = await services.listModels();
      return c.json(
        openAiModelListSchema.parse({
          object: "list",
          data: models.map(({ model }) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "zcode-manage",
          })),
        }),
      );
    },
  );

  return { app, idle: () => Promise.all(pending).then(() => undefined) };
}

function gatewayError(
  c: Context<AuthEnv>,
  status: 400 | 404 | 502,
  code: ErrorCode,
  message: string,
): Response {
  return c.json(
    apiErrorSchema.parse({ error: { code, message, requestId: c.get("requestId") } }),
    status,
  );
}
