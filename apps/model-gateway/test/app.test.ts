import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AccessTokenClaims, TokenUsage } from "@zm/contracts";
import type { ModelEndpointRow, ModelRow, UsageEventInput } from "@zm/database";
import {
  REQUEST_ID_HEADER,
  createAuthMiddleware,
  createLogger,
  type LoggerSink,
  type TokenVerification,
} from "@zm/shared";
import { createGatewayApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayServices } from "../src/services.js";

const ISSUER = "http://manage.test";
/** 上游密钥运行时随机生成，源码里不出现凭据字面量。 */
const UPSTREAM_KEY = randomBytes(16).toString("hex");

// 服务账号令牌的 sub 由颁发者填成客户端标识；显示名带 service: 前缀便于区分。
const SERVICE: AccessTokenClaims = {
  sub: "svc-dev",
  client_id: "svc-dev",
  scope: "model:invoke",
  "zm:accountType": "service",
  "zm:displayName": "service:svc-dev",
  "zm:orgId": "org-dev",
};

const NARROW: AccessTokenClaims = { ...SERVICE, scope: "openid" };

const USAGE: TokenUsage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

const ENDPOINT: ModelEndpointRow = {
  id: "mock-openai",
  name: "mock-openai",
  protocol: "openai-chat-completions",
  baseUrl: "http://upstream.test/v1",
  apiKeyEnv: "ZM_UPSTREAM_API_KEY",
};

const MODEL: ModelRow = {
  id: "glm-dev",
  endpointId: ENDPOINT.id,
  upstreamModel: "glm-upstream-name",
  displayName: "GLM（替身）",
  contextWindow: 128000,
  enabled: 1,
};

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function silentSink(): LoggerSink {
  const noop = () => {};
  return { log: noop, warn: noop, error: noop, debug: noop };
}

function sseBody(frames: unknown[], withUsage: boolean): string {
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (withUsage) {
    lines.push(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: USAGE })}\n\n`,
    );
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

interface HarnessOptions {
  /** 假上游。它不需要知道请求内容，请求内容由 calls 记录下来供断言。 */
  upstream?: () => Response | Promise<Response>;
  env?: NodeJS.ProcessEnv;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: UpstreamCall[] = [];
  const recorded: UsageEventInput[] = [];
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 8081,
    issuer: ISSUER,
    databaseUrl: "postgres://unused",
    upstreamTimeoutMs: 5_000,
  };
  const verify = async (token: string): Promise<TokenVerification> => {
    if (token === "svc") {
      return { ok: true, claims: SERVICE };
    }
    if (token === "narrow") {
      return { ok: true, claims: NARROW };
    }
    return { ok: false, reason: "signature" };
  };
  const services: GatewayServices = {
    config,
    logger: createLogger("test", { sink: silentSink(), minLevel: "error" }),
    auth: createAuthMiddleware({ verify }),
    env: options.env ?? { ZM_UPSTREAM_API_KEY: UPSTREAM_KEY },
    fetchFn: async (input, init) => {
      const call: UpstreamCall = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as unknown,
      };
      calls.push(call);
      if (!options.upstream) {
        throw new Error("harness has no upstream configured");
      }
      // 不把请求详情传给假上游：它只负责给出响应，避免它被误当成别的参数。
      return options.upstream();
    },
    findModel: async (modelId) =>
      modelId === MODEL.id ? { model: MODEL, endpoint: ENDPOINT } : undefined,
    listModels: async () => [{ model: MODEL, endpoint: ENDPOINT }],
    recordUsage: async (event) => {
      recorded.push(event);
      return true;
    },
  };
  const gateway = createGatewayApp(services);
  const post = (body: unknown, token: "svc" | "narrow" | "bad" = "svc") =>
    gateway.app.request("/gateway/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-client-private": "must-not-reach-upstream",
      },
      body: JSON.stringify(body),
    });
  return { gateway, calls, recorded, post };
}

const jsonUpstream = (status = 200) =>
  new Response(JSON.stringify({ id: "chatcmpl-up", usage: status === 200 ? USAGE : undefined }), {
    status,
    headers: { "content-type": "application/json", "x-upstream-private": "no" },
  });

const frames = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "你好" } }],
  },
];

const REQUEST = {
  model: "glm-dev",
  messages: [{ role: "user", content: "你好" }],
  temperature: 0.3,
};

describe("非流式请求", () => {
  it("上游收到的是上游密钥，调用方的令牌与私有请求头都不外泄", async () => {
    const { post, calls } = createHarness({ upstream: jsonUpstream });

    await post(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://upstream.test/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[0]?.headers["x-client-private"]).toBeUndefined();
    // 客户端用的是目录里的模型名；上游只认识它自己的名字，只有 model 字段被改写。
    expect(calls[0]?.body).toEqual({ ...REQUEST, model: "glm-upstream-name" });
  });

  it("响应体原样返回；上游的私有响应头不带回去", async () => {
    const { post } = createHarness({ upstream: jsonUpstream });
    const response = await post(REQUEST);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "chatcmpl-up", usage: USAGE });
    expect(response.headers.get("x-upstream-private")).toBeNull();
  });

  it("记一条用量：归属来自令牌，token 数与上游一致，时间在响应结束时确定", async () => {
    const { post, recorded } = createHarness({ upstream: jsonUpstream });

    await post(REQUEST);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      subjectType: "service",
      subjectId: "svc-dev",
      subjectName: "service:svc-dev",
      clientId: "svc-dev",
      model: "glm-dev",
      upstreamModel: "glm-upstream-name",
      endpointId: "mock-openai",
      statusCode: 200,
      stream: 0,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      usageSource: "upstream",
      errorKind: null,
    });
    expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorded[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("两次调用的幂等键互不相同，即使调用方带了相同的请求 ID", async () => {
    const { gateway, recorded } = createHarness({ upstream: jsonUpstream });
    const send = () =>
      gateway.app.request("/gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer svc",
          "content-type": "application/json",
          [REQUEST_ID_HEADER]: "reused-by-client",
        },
        body: JSON.stringify(REQUEST),
      });

    await send();
    await send();

    expect(recorded.map((event) => event.requestId)).toHaveLength(2);
    expect(new Set(recorded.map((event) => event.requestId)).size).toBe(2);
  });
});

describe("流式请求", () => {
  it("字节原样透传；流结束后记一条用量，stream 标记为流式", async () => {
    const { post, recorded, gateway } = createHarness({
      upstream: () =>
        new Response(sseBody(frames, true), { headers: { "content-type": "text/event-stream" } }),
    });

    const response = await post({
      ...REQUEST,
      stream: true,
      stream_options: { include_usage: true },
    });
    const text = await response.text();
    await gateway.idle();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(sseBody(frames, true));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      stream: 1,
      totalTokens: 10,
      usageSource: "upstream",
      errorKind: null,
    });
  });

  it("上游不带用量：仍然记一条，token 数为空，来源记为 missing", async () => {
    const { post, recorded, gateway } = createHarness({
      upstream: () =>
        new Response(sseBody(frames, false), { headers: { "content-type": "text/event-stream" } }),
    });

    const response = await post({ ...REQUEST, stream: true });
    await response.text();
    await gateway.idle();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      stream: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageSource: "missing",
    });
  });
});

describe("上游失败", () => {
  it("上游 5xx：状态码与响应体原样透传，用量记为 upstream_error", async () => {
    const errorBody = { error: { message: "upstream exploded", type: "server_error" } };
    const { post, recorded } = createHarness({
      upstream: () =>
        new Response(JSON.stringify(errorBody), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const response = await post(REQUEST);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(errorBody);
    expect(recorded[0]).toMatchObject({
      statusCode: 500,
      usageSource: "missing",
      errorKind: "upstream_error",
    });
  });

  it("上游 4xx：归为 client_error", async () => {
    const { post, recorded } = createHarness({ upstream: () => jsonUpstream(429) });

    await post(REQUEST);

    expect(recorded[0]).toMatchObject({ statusCode: 429, errorKind: "client_error" });
  });

  it("连不上上游：502 与统一错误体，用量记为 network_error", async () => {
    const { post, recorded, calls } = createHarness({
      upstream: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const response = await post(REQUEST);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "upstream_error", requestId: expect.any(String) },
    });
    expect(calls).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      statusCode: 502,
      usageSource: "missing",
      errorKind: "network_error",
    });
  });
});

describe("不该触达上游的请求", () => {
  it("没有令牌、令牌无效、缺范围：分别是 401、401、403，都不记用量", async () => {
    for (const [token, status] of [
      ["bad", 401],
      ["narrow", 403],
    ] as const) {
      const { post, calls, recorded } = createHarness({ upstream: jsonUpstream });

      expect((await post(REQUEST, token)).status).toBe(status);
      expect(calls).toHaveLength(0);
      expect(recorded).toHaveLength(0);
    }
    const { gateway, calls, recorded } = createHarness({ upstream: jsonUpstream });
    const missing = await gateway.app.request("/gateway/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(REQUEST),
    });

    expect(missing.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("模型不在目录里：404 model_not_found", async () => {
    const { post, calls, recorded } = createHarness({ upstream: jsonUpstream });
    const response = await post({ ...REQUEST, model: "not-in-catalog" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_found" } });
    expect(calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("请求体不符合 Chat Completions：400 validation_error", async () => {
    const { post, calls } = createHarness({ upstream: jsonUpstream });
    const response = await post({ messages: [{ role: "user", content: "缺 model" }] });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    expect(calls).toHaveLength(0);
  });

  it("上游密钥没有配置：是部署问题，返回 500，不发出请求", async () => {
    const { post, calls, recorded } = createHarness({ upstream: jsonUpstream, env: {} });
    const response = await post(REQUEST);

    expect(response.status).toBe(500);
    expect(calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
});

describe("模型列表", () => {
  it("按 OpenAI 的 list 形状返回目录，同样要求令牌", async () => {
    const { gateway } = createHarness({ upstream: jsonUpstream });
    const anonymous = await gateway.app.request("/gateway/v1/models");

    expect(anonymous.status).toBe(401);

    const response = await gateway.app.request("/gateway/v1/models", {
      headers: { authorization: "Bearer svc" },
    });

    expect(await response.json()).toEqual({
      object: "list",
      data: [{ id: "glm-dev", object: "model", created: 0, owned_by: "zcode-manage" }],
    });
  });
});
