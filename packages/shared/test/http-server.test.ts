import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger, listenForTest, type LoggerSink } from "../src/index.js";

function createSilentSink(): LoggerSink & { lines: string[] } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, log: record, warn: record, error: record, debug: record };
}

describe("startHttpServer", () => {
  it("普通路径交给 Hono；登记了接管函数的路径直接走原生处理器", async () => {
    const sink = createSilentSink();
    const app = new Hono();
    app.get("/api/hello", (c) => c.text("from hono"));
    const handle = await listenForTest({
      fetch: (request) => app.fetch(request),
      logger: createLogger("test", { sink, minLevel: "debug" }),
      intercept: (pathname) =>
        pathname === "/taken"
          ? (_req: IncomingMessage, res: ServerResponse) => {
              res.writeHead(200, { "content-type": "text/plain" });
              res.end("from intercept");
            }
          : undefined,
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const hono = await fetch(`${base}/api/hello`);
      const taken = await fetch(`${base}/taken`);

      expect(await hono.text()).toBe("from hono");
      expect(await taken.text()).toBe("from intercept");
      // 端口是临时分配的，不是 0。
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });

  it("接管函数抛异常：返回 500 并记日志，不让进程崩掉", async () => {
    const sink = createSilentSink();
    const logger = createLogger("test", { sink, minLevel: "debug" });
    const handle = await listenForTest({
      fetch: () => Promise.resolve(new Response("unused")),
      logger,
      intercept: () => () => {
        throw new Error("boom in intercept");
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/anything`);

      expect(response.status).toBe(500);
      expect(sink.lines.some((line) => line.includes("intercept handler failed"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("close 在一个请求还没结束时不会立刻返回，请求结束后才返回", async () => {
    let release: () => void = () => {};
    const app = new Hono();
    app.get("/slow", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response("done");
    });
    const handle = await listenForTest({
      fetch: (request) => app.fetch(request),
      logger: createLogger("test", { sink: createSilentSink() }),
    });
    const responsePromise = fetch(`http://127.0.0.1:${handle.port}/slow`);
    // 等到请求确实已经到达服务端再开始关闭。
    await new Promise((resolve) => setTimeout(resolve, 50));

    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closed).toBe(false);
    release();
    expect(await (await responsePromise).text()).toBe("done");
    await closing;
    expect(closed).toBe(true);
  });
});
