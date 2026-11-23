import { z } from "zod";
import { instantSchema, uuidSchema } from "./common.js";

/** 管控平面内的模型目录。客户端用 id 作为请求里的 model。 */
export const modelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    contextWindow: z.number().int().positive(),
    endpointId: z.string().min(1),
  })
  .strict();
export type Model = z.infer<typeof modelSchema>;

export const modelListResponseSchema = z.object({ models: z.array(modelSchema) }).strict();
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

/** 网关的 /models 响应，形状遵循 OpenAI 的 list 接口。 */
export const openAiModelListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          object: z.literal("model"),
          created: z.number().int(),
          owned_by: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type OpenAiModelList = z.infer<typeof openAiModelListSchema>;

/* ---------- Chat Completions ---------- */

/**
 * 请求体只做“取信息”，不做完整校验：Chat Completions 的合法字段很多，而且随上游演进。
 * 网关只关心下面几个字段，其余原样转发。messages 在这里只声明为存在，不约束内容。
 */
export const chatCompletionRequestMetaSchema = z.looseObject({
  model: z.string().min(1),
  stream: z.boolean().default(false),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).optional(),
});
export type ChatCompletionRequestMeta = z.infer<typeof chatCompletionRequestMetaSchema>;

export const tokenUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .loose();
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const chatCompletionResponseSchema = z.looseObject({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.looseObject({
      index: z.number().int(),
      message: z.looseObject({ role: z.string(), content: z.string().nullable() }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: tokenUsageSchema.nullable().optional(),
});
export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;

/** 流式响应里的一个数据块。usage 只在最后一个数据块里出现。 */
export const chatCompletionChunkSchema = z.looseObject({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.looseObject({
      index: z.number().int(),
      delta: z.looseObject({
        role: z.string().optional(),
        content: z.string().nullable().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: tokenUsageSchema.nullable().optional(),
});
export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;

/* ---------- 用量 ---------- */

export const usageSourceSchema = z.enum(["upstream", "estimated", "missing"]);

/** 网关记录一条用量时给出的失败分类。成功时为 null。 */
export const usageErrorKindSchema = z.enum(["client_error", "upstream_error", "network_error"]);
export type UsageErrorKind = z.infer<typeof usageErrorKindSchema>;

export const usageEventSchema = z
  .object({
    id: uuidSchema,
    requestId: z.string().min(1),
    occurredAt: instantSchema,
    subjectType: z.enum(["user", "service"]),
    subjectId: z.string().min(1),
    subjectName: z.string(),
    clientId: z.string().min(1),
    model: z.string().min(1),
    upstreamModel: z.string(),
    endpointId: z.string().min(1),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    statusCode: z.number().int(),
    stream: z.boolean(),
    durationMs: z.number().int().nonnegative().nullable(),
    usageSource: usageSourceSchema,
    /** 网关记录用量时给出的失败分类；成功时为 null。 */
    errorKind: usageErrorKindSchema.nullable(),
  })
  .strict();
export type UsageEvent = z.infer<typeof usageEventSchema>;
export type UsageSource = z.infer<typeof usageSourceSchema>;

export const usageEventPageSchema = z
  .object({
    items: z.array(usageEventSchema),
    /** 为 null 表示没有下一页。 */
    nextCursor: z.string().nullable(),
  })
  .strict();
export type UsageEventPage = z.infer<typeof usageEventPageSchema>;

export const listUsageEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().min(1).max(1024).optional(),
});
export type ListUsageEventsQuery = z.infer<typeof listUsageEventsQuerySchema>;

/* ---------- 只定义契约、本期不实现的接口 ---------- */

export const policyDocumentSchema = z
  .object({
    revision: z.number().int().positive(),
    issuedAt: instantSchema,
    keyId: z.string().min(1),
    algorithm: z.literal("EdDSA"),
    /** payload 的规范化 JSON（键排序、无多余空白）的签名，base64url。 */
    payload: z.record(z.string(), z.unknown()),
    signature: z.string().min(1),
  })
  .strict();
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

export const eventBatchRequestSchema = z
  .object({
    /** 幂等键。同一客户端重复提交同一批次时返回第一次的结果。 */
    batchId: uuidSchema,
    deviceId: uuidSchema,
    clientVersion: z.string().min(1),
    events: z
      .array(
        z.object({
          eventId: uuidSchema,
          type: z.enum(["session", "tool_call", "approval", "client_metrics"]),
          occurredAt: instantSchema,
          payload: z.unknown(),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type EventBatchRequest = z.infer<typeof eventBatchRequestSchema>;

export const eventBatchResponseSchema = z
  .object({ accepted: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative() })
  .strict();
