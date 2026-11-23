import type { Context } from "hono";
import { Hono } from "hono";
import {
  chatCompletionChunkSchema,
  chatCompletionRequestMetaSchema,
  chatCompletionResponseSchema,
  openAiModelListSchema,
  type ChatCompletionChunk,
  type TokenUsage,
} from "@zm/contracts";
import { createBaseApp, type ServiceAppEnv } from "@zm/shared";
import { ZM_VERSION } from "./build-time.js";
import type { MockModelConfig } from "./config.js";

export const SERVICE_NAME = "mock-model";

export const MOCK_MODELS = ["glm-dev", "glm-dev-mini"] as const;
/** 请求这个模型名时固定返回 500，用来验证网关对上游失败的透传。 */
export const MOCK_FAILING_MODEL = "fail-500";

/** 每个流式数据块携带的字符数。按码点切分，不会把中文或 emoji 切成两半。 */
const STREAM_PIECE_PATTERN = /.{1,6}/gu;

type MockEnv = ServiceAppEnv;
type MockContext = Context<MockEnv>;

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

export interface MockAppDeps {
  config: Pick<MockModelConfig, "apiKey" | "streamChunkDelayMs">;
  /** 仅供测试替换等待与时钟。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * OpenAI 兼容的假模型服务。回复是固定的回显，用量按字符数粗算，
 * 目的是让调用方可以断言“请求原样到达了上游、用量被原样解析”。
 */
export function createMockApp(deps: MockAppDeps): Hono<MockEnv> {
  const app = createBaseApp<MockEnv>({ service: SERVICE_NAME, version: ZM_VERSION });
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  function authorized(c: MockContext): boolean {
    const header = (c.req.header("authorization") ?? "").trim();
    const prefix = header.slice(0, 7).toLowerCase();
    return prefix === "bearer " && header.slice(7).trim() === deps.config.apiKey;
  }

  app.post("/v1/chat/completions", async (c) => {
    // 替身服务会拒绝凭证不对的请求。网关若忘了把调用方的令牌换成上游密钥，这里就会暴露。
    if (!authorized(c)) {
      return openAiError(c, 401, "invalid_api_key", "mock upstream rejected the credential");
    }
    const json: unknown = await c.req.json().catch(() => undefined);
    const meta = chatCompletionRequestMetaSchema.safeParse(json);
    if (!meta.success) {
      return openAiError(c, 400, "invalid_request_error", "body is not a Chat Completions request");
    }
    const body = json as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
    if (meta.data.model === MOCK_FAILING_MODEL) {
      return openAiError(c, 500, "server_error", "mock upstream deliberate failure");
    }
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const fullText = textOf(lastUser);
    // 太长的消息只回显开头，并明确标出被截断。
    const echoed = fullText.length > 200 ? `${fullText.slice(0, 200)}…` : fullText;
    const content = `这是本地替身服务的回复。你说：${echoed}`;
    const id = `chatcmpl-mock-${c.get("requestId")}`;
    const created = now();
    const promptText = messages.map(textOf).join("\n");

    if (meta.data.stream) {
      const includeUsage = meta.data.stream_options?.include_usage === true;
      const stream = sseStream(
        (async function* generate() {
          yield chunk(id, created, meta.data.model, {
            index: 0,
            delta: { role: "assistant", content: "" },
          });
          for (const piece of content.match(STREAM_PIECE_PATTERN) ?? [content]) {
            await sleep(deps.config.streamChunkDelayMs);
            yield chunk(id, created, meta.data.model, { index: 0, delta: { content: piece } });
          }
          yield chunk(id, created, meta.data.model, { index: 0, delta: {}, finish_reason: "stop" });
          // 与 OpenAI 一致：带 usage 的块放在最后，choices 为空数组。
          if (includeUsage) {
            yield {
              id,
              object: "chat.completion.chunk",
              created,
              model: meta.data.model,
              choices: [],
              usage: usageFor(promptText, content),
            };
          }
        })(),
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return c.json(
      chatCompletionResponseSchema.parse({
        id,
        object: "chat.completion",
        created,
        model: meta.data.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: usageFor(promptText, content),
      }),
    );
  });

  app.get("/v1/models", (c) => {
    if (!authorized(c)) {
      return openAiError(c, 401, "invalid_api_key", "mock upstream rejected the credential");
    }
    return c.json(
      openAiModelListSchema.parse({
        object: "list",
        data: MOCK_MODELS.map((model) => ({
          id: model,
          object: "model",
          created: 0,
          owned_by: "zm-mock",
        })),
      }),
    );
  });

  return app;
}

function textOf(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/** 按 4 个字符 1 个 token 粗算，只为给出确定的数值；空文本至少记 1 个。 */
function usageFor(promptText: string, completionText: string): TokenUsage {
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(1, Math.ceil(completionText.length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function chunk(id: string, created: number, model: string, choice: object): ChatCompletionChunk {
  return chatCompletionChunkSchema.parse({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [choice],
  });
}

async function* sseLines(chunks: AsyncGenerator<unknown>): AsyncGenerator<string> {
  for await (const item of chunks) {
    yield `data: ${JSON.stringify(item)}\n\n`;
  }
  yield "data: [DONE]\n\n";
}

/**
 * 把一串数据块变成 SSE 响应体。按需拉取：调用方断开时停止生成，不会白跑完。
 */
function sseStream(chunks: AsyncGenerator<unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = sseLines(chunks);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await lines.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
}

/** 上游的错误体遵循 OpenAI 的形状，网关原样透传。 */
function openAiError(
  c: MockContext,
  status: 400 | 401 | 500,
  type: string,
  message: string,
): Response {
  return c.json({ error: { message, type, param: null, code: null } }, status);
}
