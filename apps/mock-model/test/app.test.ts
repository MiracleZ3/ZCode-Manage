import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServiceAppEnv } from "@zm/shared";
import { MOCK_FAILING_MODEL, MOCK_MODELS, SERVICE_NAME, createMockApp } from "../src/app.js";

/** 上游密钥运行时随机生成，源码里不出现凭据字面量。 */
const API_KEY = randomBytes(12).toString("hex");

type MockApp = Hono<ServiceAppEnv>;

/** 不等待、时钟固定，测试既快又能断言确定的数值。 */
function createApp(): MockApp {
  return createMockApp({
    config: { apiKey: API_KEY, streamChunkDelayMs: 0 },
    sleep: async () => {},
    now: () => 1_700_000_000,
  });
}

const authorized = { authorization: `Bearer ${API_KEY}` };

// app.request 有时同步返回响应，包成 async 让返回类型稳定。
async function post(
  app: MockApp,
  body: unknown,
  headers: Record<string, string> = authorized,
): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter((frame) => frame.length > 0 && frame !== "[DONE]")
    .map((frame) => JSON.parse(frame));
}

const MESSAGES = [
  { role: "system", content: "12345678" },
  { role: "user", content: "abcd" },
];

describe("非流式", () => {
  it("回显最后一条用户消息，用量按字符数粗算", async () => {
    const response = await post(createApp(), { model: "glm-dev", messages: MESSAGES });

    expect(response.status).toBe(200);
    // 提示词是两条消息用换行拼接，共 13 个字符，按 4 个字符 1 个 token 得 4；
    // 回复“这是本地替身服务的回复。你说：abcd”共 19 个字符，得 5。
    expect(await response.json()).toMatchObject({
      id: `chatcmpl-mock-${response.headers.get("x-request-id")}`,
      object: "chat.completion",
      created: 1_700_000_000,
      model: "glm-dev",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "这是本地替身服务的回复。你说：abcd" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
  });

  it("凭证不对：401，错误体遵循 OpenAI 的形状", async () => {
    const response = await post(
      createApp(),
      { model: "glm-dev", messages: MESSAGES },
      { authorization: "Bearer wrong" },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_api_key" } });
  });

  it("请求体里没有 model：400", async () => {
    const response = await post(createApp(), { messages: MESSAGES });

    expect(response.status).toBe(400);
  });

  it("请求故意失败的模型：返回 500", async () => {
    const response = await post(createApp(), { model: MOCK_FAILING_MODEL, messages: MESSAGES });

    expect(response.status).toBe(500);
  });
});

describe("流式", () => {
  const streamRequest = { model: "glm-dev-mini", messages: MESSAGES, stream: true };

  it("数据块的 content 拼起来就是完整回复，最后以 [DONE] 结束", async () => {
    const response = await post(createApp(), streamRequest);
    const text = await response.text();
    const frames = parseFrames(text) as {
      choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
    }[];

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(frames[0]?.choices[0]?.delta).toMatchObject({ role: "assistant" });
    const content = frames.map((frame) => frame.choices[0]?.delta.content ?? "").join("");
    expect(content).toBe("这是本地替身服务的回复。你说：abcd");
    expect(frames.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    // 没有要用量，就不发带 usage 的数据块。
    expect(frames.some((frame) => "usage" in frame)).toBe(false);
  });

  it("要求带用量时，最后一块带 usage 且 choices 为空数组", async () => {
    const response = await post(createApp(), {
      ...streamRequest,
      stream_options: { include_usage: true },
    });
    const frames = parseFrames(await response.text()) as Record<string, unknown>[];
    const last = frames.at(-1);

    expect(last).toMatchObject({
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
  });

  it("流式请求同样要校验凭证", async () => {
    const response = await post(createApp(), streamRequest, {});

    expect(response.status).toBe(401);
  });
});

describe("模型列表与健康检查", () => {
  it("列出替身服务提供的模型；没有凭证时拒绝", async () => {
    const app = createApp();
    const response = await app.request("/v1/models", { headers: authorized });

    expect(await (await app.request("/v1/models")).status).toBe(401);
    expect(await response.json()).toMatchObject({
      object: "list",
      data: MOCK_MODELS.map((id) => ({ id, object: "model" })),
    });
  });

  it("健康检查报出服务名", async () => {
    const response = await createApp().request("/healthz");

    expect(await response.json()).toMatchObject({ status: "ok", service: SERVICE_NAME });
  });

  it("特别长的用户消息只回显前 200 个字符", async () => {
    const response = await post(createApp(), {
      model: "glm-dev",
      messages: [{ role: "user", content: "x".repeat(250) }],
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };

    expect(body.choices[0]?.message.content).toBe(
      `这是本地替身服务的回复。你说：${"x".repeat(200)}…`,
    );
  });
});
