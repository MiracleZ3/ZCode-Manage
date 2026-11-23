import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  createUsageParser,
  extractJsonUsage,
  pickUsageSource,
} from "../src/proxy.js";

const USAGE = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

function sse(...frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

const chunk = (delta: object) => ({
  id: "c1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta }],
});

describe("createUsageParser", () => {
  it("用量在最后一个数据块里：流结束时取到", async () => {
    const parser = createUsageParser();
    parser.push(
      new TextEncoder().encode(
        sse(chunk({ content: "你" }), chunk({ content: "好" }), { choices: [], usage: USAGE }),
      ),
    );
    parser.finish();

    expect(await parser.usage).toEqual(USAGE);
  });

  it("上游可能把一行拆在多个字节块里，也可能用 CRLF，都不能漏掉", async () => {
    const parser = createUsageParser();
    const text = sse(chunk({ content: "a" }), { choices: [], usage: USAGE }).replace(
      "\n\n",
      "\r\n\r\n",
    );
    const bytes = new TextEncoder().encode(text);
    // 一个字节一个字节地喂，模拟最坏的切分。
    for (const byte of bytes) {
      parser.push(new Uint8Array([byte]));
    }
    parser.finish();

    expect(await parser.usage).toEqual(USAGE);
  });

  it("最后一块后面没有换行：结束时也要处理", async () => {
    const parser = createUsageParser();
    parser.push(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: USAGE })}`));
    parser.finish();

    expect(await parser.usage).toEqual(USAGE);
  });

  it("上游不带用量：得到 undefined，而不是报错或编一个数", async () => {
    const parser = createUsageParser();
    parser.push(new TextEncoder().encode(`${sse(chunk({ content: "ok" }))}data: [DONE]\n\n`));
    parser.finish();

    expect(await parser.usage).toBeUndefined();
  });

  it("夹着坏行、注释、不完整的 JSON 都不会影响取用量", async () => {
    const parser = createUsageParser();
    parser.push(
      new TextEncoder().encode(
        [
          ": keep-alive",
          "data: {not json",
          "data: null",
          "event: message",
          `data: ${JSON.stringify({ choices: [], usage: USAGE })}`,
          "data: [DONE]",
        ].join("\n\n"),
      ),
    );
    parser.finish();

    expect(await parser.usage).toEqual(USAGE);
  });

  it("usage 字段存在但数值不完整：当作没有用量", async () => {
    const parser = createUsageParser();
    parser.push(new TextEncoder().encode(sse({ choices: [], usage: { prompt_tokens: 1 } })));
    parser.finish();

    expect(await parser.usage).toBeUndefined();
  });
});

describe("extractJsonUsage", () => {
  it("从非流式响应体里取用量", () => {
    expect(extractJsonUsage(JSON.stringify({ id: "x", usage: USAGE }))).toEqual(USAGE);
    expect(extractJsonUsage(JSON.stringify({ id: "x", usage: null }))).toBeUndefined();
    expect(extractJsonUsage("<html>502 Bad Gateway</html>")).toBeUndefined();
    expect(extractJsonUsage("not json at all")).toBeUndefined();
  });
});

describe("结果归类", () => {
  it("成功为 null；上游 5xx、4xx、连不上分别归类", () => {
    expect(classifyOutcome(200, false)).toBeNull();
    expect(classifyOutcome(500, false)).toBe("upstream_error");
    expect(classifyOutcome(429, false)).toBe("client_error");
    expect(classifyOutcome(502, true)).toBe("network_error");
  });

  it("用量来源：有精确用量记 upstream，否则记 missing", () => {
    expect(pickUsageSource(USAGE)).toBe("upstream");
    expect(pickUsageSource(undefined)).toBe("missing");
  });
});
