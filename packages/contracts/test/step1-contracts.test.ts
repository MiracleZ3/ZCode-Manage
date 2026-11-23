import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  chatCompletionChunkSchema,
  chatCompletionRequestMetaSchema,
  chatCompletionResponseSchema,
  eventBatchRequestSchema,
  healthResponseSchema,
  modelListResponseSchema,
  parseScopes,
  policyDocumentSchema,
  registerDeviceRequestSchema,
  usageEventSchema,
} from "../src/index.js";
import { accessTokenClaimsSchema } from "../src/index.js";

const CLAIMS = {
  sub: "user-1",
  client_id: "zcode-ee-dev",
  scope: "openid model:invoke",
  "zm:accountType": "user",
  "zm:displayName": "Alice",
  "zm:orgId": "org-dev",
};

describe("parseScopes", () => {
  it("按空白拆分，忽略连续空格与空值", () => {
    expect([...parseScopes("  openid   model:invoke ")]).toEqual(["openid", "model:invoke"]);
    expect(parseScopes(undefined).size).toBe(0);
  });
});

describe("accessTokenClaimsSchema", () => {
  it("接受带自定义声明的访问令牌载荷", () => {
    expect(accessTokenClaimsSchema.parse(CLAIMS)).toEqual(CLAIMS);
  });

  it("缺少归属字段时不通过：网关据此判断归属，不允许缺", () => {
    const withoutOrg: Record<string, unknown> = { ...CLAIMS };
    delete withoutOrg["zm:orgId"];
    expect(accessTokenClaimsSchema.safeParse(withoutOrg).success).toBe(false);
  });

  it("账号类型只有用户与服务账号两种", () => {
    expect(
      accessTokenClaimsSchema.safeParse({ ...CLAIMS, "zm:accountType": "admin" }).success,
    ).toBe(false);
    expect(
      accessTokenClaimsSchema.safeParse({
        ...CLAIMS,
        "zm:accountType": "service",
        sub: "service:svc",
      }).success,
    ).toBe(true);
  });
});

describe("Chat Completions 请求", () => {
  it("只取网关关心的字段，其余字段保留不动", () => {
    const request = {
      model: "glm-dev",
      messages: [{ role: "user", content: "你好" }],
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "f" } }],
    };
    const parsed = chatCompletionRequestMetaSchema.parse(request);
    expect(parsed.model).toBe("glm-dev");
    expect(parsed.stream).toBe(false);
  });

  it("缺少 model 时拒绝；这是网关查目录的唯一依据", () => {
    expect(chatCompletionRequestMetaSchema.safeParse({ messages: [] }).success).toBe(false);
  });
});

describe("用量", () => {
  it("非流式响应里的 usage 被识别", () => {
    const response = chatCompletionResponseSchema.parse({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "glm-dev",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(response.usage?.total_tokens).toBe(5);
  });

  it("流式数据块里 usage 缺省为空，出现时必须完整", () => {
    const chunk = { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [] };
    expect(chatCompletionChunkSchema.parse(chunk).usage).toBeUndefined();
    expect(
      chatCompletionChunkSchema.safeParse({ ...chunk, usage: { prompt_tokens: 1 } }).success,
    ).toBe(false);
    expect(
      chatCompletionChunkSchema.parse({
        ...chunk,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }).usage?.total_tokens,
    ).toBe(2);
  });

  it("用量明细不能带未知字段，时间必须是带时区的 ISO 8601", () => {
    const event = {
      id: "0f0e6d5a-1111-4222-8333-444455556666",
      requestId: "req-1",
      occurredAt: "2026-11-23T10:00:00.000Z",
      subjectType: "service",
      subjectId: "service:svc",
      subjectName: "service:svc",
      clientId: "svc",
      model: "glm-dev",
      upstreamModel: "glm-dev",
      endpointId: "mock",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      statusCode: 502,
      stream: true,
      durationMs: 12,
      usageSource: "missing",
      errorKind: "network_error",
    };
    expect(usageEventSchema.parse(event)).toEqual(event);
    expect(
      usageEventSchema.safeParse({ ...event, occurredAt: "2026-11-23T10:00:00" }).success,
    ).toBe(false);
    expect(usageEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
  });
});

describe("其余契约", () => {
  it("设备注册请求会裁剪空白并限制长度；平台只接受四种取值", () => {
    expect(
      registerDeviceRequestSchema.parse({
        name: " 我的电脑 ",
        platform: "darwin",
        clientVersion: "1.0.0",
      }).name,
    ).toBe("我的电脑");
    expect(
      registerDeviceRequestSchema.safeParse({ name: "x", platform: "freebsd", clientVersion: "1" })
        .success,
    ).toBe(false);
  });

  it("模型目录与错误体", () => {
    expect(
      modelListResponseSchema.safeParse({
        models: [{ id: "glm-dev", displayName: "x", contextWindow: 128000, endpointId: "mock" }],
      }).success,
    ).toBe(true);
    expect(
      healthResponseSchema.safeParse({ status: "ok", service: "a", version: "1" }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({ error: { code: "unauthorized", message: "x", requestId: "r" } })
        .success,
    ).toBe(true);
  });

  it("本期只定义契约的接口：策略文档与事件批次", () => {
    expect(
      policyDocumentSchema.safeParse({
        revision: 1,
        issuedAt: "2026-11-23T10:00:00.000Z",
        keyId: "k1",
        algorithm: "EdDSA",
        payload: { a: 1 },
        signature: "sig",
      }).success,
    ).toBe(true);
    const batch = {
      batchId: "0f0e6d5a-1111-4222-8333-444455556666",
      deviceId: "0f0e6d5a-1111-4222-8333-444455556667",
      clientVersion: "1.0.0",
      events: [
        {
          eventId: "0f0e6d5a-1111-4222-8333-444455556668",
          type: "tool_call",
          occurredAt: "2026-11-23T10:00:00.000Z",
          payload: {},
        },
      ],
    };
    expect(eventBatchRequestSchema.parse(batch)).toEqual(batch);
    expect(eventBatchRequestSchema.safeParse({ ...batch, events: [] }).success).toBe(false);
  });
});
