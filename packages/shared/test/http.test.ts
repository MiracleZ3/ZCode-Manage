import { describe, expect, it } from "vitest";
import {
  REQUEST_ID_HEADER,
  createBaseApp,
  resolveRequestId,
  type BaseServiceAppOptions,
} from "../src/http.js";
import { createLogger, type LoggerSink } from "../src/logger.js";

function createTestApp(options: Partial<BaseServiceAppOptions> = {}) {
  const lines: string[] = [];
  // sink 收到的第一个参数永远是日志前缀，其余是调用方传入的字段；这里只记录前缀。
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${String(args[0])}`);
    };
  const sink: LoggerSink = {
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  };
  const app = createBaseApp({
    service: "test-service",
    version: "1.0.0",
    logger: createLogger("test", { sink, minLevel: "debug" }),
    ...options,
  });
  return { app, lines };
}

describe("resolveRequestId", () => {
  it("合法的请求 ID 原样沿用，并去掉首尾空白", () => {
    expect(resolveRequestId(" req-1 ")).toBe("req-1");
  });

  it("没有请求 ID 时生成 UUID", () => {
    expect(resolveRequestId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("含控制字符或超长的值被丢弃，不进入日志和响应头", () => {
    expect(resolveRequestId("bad\u001fid")).not.toBe("bad\u001fid");
    expect(resolveRequestId("a".repeat(129))).not.toHaveLength(129);
  });
});

describe("createBaseApp", () => {
  it("健康检查通过契约校验后返回", async () => {
    const { app } = createTestApp();

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "test-service",
      version: "1.0.0",
    });
  });

  it("每个响应都回传请求 ID", async () => {
    const { app } = createTestApp();

    const response = await app.request("/healthz");

    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("未匹配的路由返回 not_found", async () => {
    const { app } = createTestApp();

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("未捕获的错误返回 internal_error，不泄漏内部细节，并按请求 ID 记日志", async () => {
    const { app, lines } = createTestApp();
    app.get("/boom", () => {
      throw new Error("secret internal detail");
    });

    const response = await app.request("/boom", {
      headers: { [REQUEST_ID_HEADER]: "req-boom" },
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal Server Error", requestId: "req-boom" },
    });
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
    expect(
      lines.some((line) => line.startsWith("error ") && line.includes("[trace:req-boom]")),
    ).toBe(true);
  });
});
