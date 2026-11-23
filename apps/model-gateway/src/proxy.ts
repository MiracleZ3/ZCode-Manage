import type { TokenUsage, UsageErrorKind, UsageSource } from "@zm/contracts";
import type { ModelEndpointRow } from "@zm/database";

export interface UpstreamRequest {
  endpoint: ModelEndpointRow;
  body: unknown;
  stream: boolean;
}

export type UpstreamResult =
  | {
      ok: true;
      status: number;
      /** 交给客户端的响应。流式时响应体边转发边被解析，字节不变。 */
      response: Response;
      /** 用量要到响应结束才确定，所以用 Promise 交回。 */
      usage: Promise<TokenUsage | undefined>;
    }
  | {
      ok: false;
      /** 连不上上游，或等响应头超时。上游给出的 4xx、5xx 不算这类失败，照常透传。 */
      reason: "network_error";
    };

export interface ForwardOptions {
  fetchFn?: typeof fetch;
  timeoutMs: number;
  /** 读取上游密钥的环境变量。密钥本身不进数据库，也不进日志。 */
  env: NodeJS.ProcessEnv;
}

/**
 * 把请求转发到 OpenAI 兼容的上游。
 * 调用方的令牌在这里换成上游密钥；客户端带来的其他请求头一概不转发。
 */
export async function forwardToUpstream(
  request: UpstreamRequest,
  options: ForwardOptions,
): Promise<UpstreamResult> {
  const apiKey = options.env[request.endpoint.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`upstream api key is not configured: ${request.endpoint.apiKeyEnv}`);
  }
  // base_url 形如 http://host:port/v1。
  const url = `${request.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let upstream: Response;
  try {
    upstream = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!upstream.body) {
    return {
      ok: true,
      status: upstream.status,
      response: passthrough(upstream, null),
      usage: Promise.resolve(undefined),
    };
  }

  if (!isEventStream(upstream)) {
    // 非流式：整段读出来再交给调用方，用量在返回前就已确定。
    const text = await upstream.text();
    return {
      ok: true,
      status: upstream.status,
      response: passthrough(upstream, text),
      usage: Promise.resolve(extractJsonUsage(text)),
    };
  }

  const parser = createUsageParser();
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parser.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        parser.finish();
      },
    }),
  );
  return {
    ok: true,
    status: upstream.status,
    response: passthrough(upstream, body),
    usage: parser.usage,
  };
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/** 服务端运行时没有 DOM 的 BodyInit 类型，这里显式写出转发时会用到的两种响应体。 */
type ForwardedBody = string | ReadableStream<Uint8Array> | null;

/** 只带回与客户端解析响应有关的响应头。上游的 CORS、凭证类响应头一律不带。 */
function passthrough(upstream: Response, body: ForwardedBody): Response {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new Response(body, { status: upstream.status, headers });
}

export function extractJsonUsage(text: string): TokenUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  return pickUsage((parsed as { usage?: unknown }).usage);
}

/** 三个 token 数必须都是有限的非负数，缺一个就当作没有用量。 */
function pickUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const prompt = record.prompt_tokens;
  const completion = record.completion_tokens;
  const total = record.total_tokens;
  if (!isTokenCount(prompt) || !isTokenCount(completion) || !isTokenCount(total)) {
    return undefined;
  }
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 流式响应的用量解析器。SSE 以换行分帧，数据行形如 `data: {...}`。
 * 上游可能只在最后一个数据块里带 usage，也可能整个不带；这里取最后一次出现的。
 */
export function createUsageParser(): {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
  usage: Promise<TokenUsage | undefined>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  let found: TokenUsage | undefined;
  let resolveUsage: (usage: TokenUsage | undefined) => void = () => {};
  const usage = new Promise<TokenUsage | undefined>((resolve) => {
    resolveUsage = resolve;
  });

  function consumeLine(line: string): void {
    const data = line.replace(/\r$/, "").match(/^data:\s*(.*)$/)?.[1];
    if (!data || data === "[DONE]") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed === "object" && parsed !== null) {
      found = pickUsage((parsed as { usage?: unknown }).usage) ?? found;
    }
  }

  return {
    push(chunk) {
      // stream: true 让跨块的多字节字符保持完整。
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        consumeLine(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
      }
    },
    finish() {
      buffer += decoder.decode();
      // 流结束时把剩下的最后一行也处理掉，它可能正是带 usage 的那一块。
      if (buffer.length > 0) {
        consumeLine(buffer);
      }
      resolveUsage(found);
    },
    usage,
  };
}

/** 把网关看到的结果归类，写进用量明细，便于按失败原因统计。 */
export function classifyOutcome(status: number, networkFailed: boolean): UsageErrorKind | null {
  if (networkFailed) {
    return "network_error";
  }
  if (status >= 500) {
    return "upstream_error";
  }
  if (status >= 400) {
    return "client_error";
  }
  return null;
}

export function pickUsageSource(usage: TokenUsage | undefined): UsageSource {
  return usage ? "upstream" : "missing";
}
