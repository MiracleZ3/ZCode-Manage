import { describe, expect, it } from "vitest";
import { formatLogPrefix } from "../src/log-format.js";
import { createLogger, resolveDefaultMinLevel, type LoggerSink } from "../src/logger.js";
import { readTrimmedEnv } from "../src/env.js";

const FIXED_TIME = "2026-11-23T10:00:00.000Z";

function createRecorderSink(): { sink: LoggerSink; lines: string[] } {
  const lines: string[] = [];
  // sink 收到的第一个参数永远是日志前缀，其余是调用方传入的字段；这里只记录前缀。
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${String(args[0])}`);
    };
  return {
    lines,
    sink: {
      log: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
  };
}

describe("formatLogPrefix", () => {
  it("版式与 ZCode 服务端一致，时间戳为 ISO 8601 UTC", () => {
    expect(formatLogPrefix("manage-api:http", { pid: 42, now: new Date(FIXED_TIME) })).toBe(
      `[${FIXED_TIME}] [pid:42] [manage-api:http]`,
    );
  });

  it("带 trace ID 时追加在 scope 之后", () => {
    expect(
      formatLogPrefix("gateway:http", { pid: 42, traceId: "req-1", now: new Date(FIXED_TIME) }),
    ).toBe(`[${FIXED_TIME}] [pid:42] [gateway:http][trace:req-1]`);
  });
});

describe("createLogger", () => {
  const fixedNow = () => new Date(FIXED_TIME);

  it("低于最低级别的日志不输出", () => {
    const { sink, lines } = createRecorderSink();
    const logger = createLogger("scope", { pid: 42, sink, minLevel: "info", now: fixedNow });

    logger.debug(undefined, "hidden");
    logger.info(undefined, "shown");

    expect(lines).toEqual([`info [${FIXED_TIME}] [pid:42] [scope]`]);
  });

  it("每个级别写到 sink 对应的方法", () => {
    const { sink, lines } = createRecorderSink();
    const logger = createLogger("scope", { pid: 42, sink, minLevel: "debug", now: fixedNow });

    logger.debug("a", 1);
    logger.info("b", 2);
    logger.warn("c", 3);
    logger.error("d", 4);

    expect(lines.map((line) => line.split(" ")[0])).toEqual(["debug", "info", "warn", "error"]);
  });

  it("trace ID 进入日志前缀", () => {
    const { sink, lines } = createRecorderSink();
    const logger = createLogger("scope", { pid: 42, sink, minLevel: "debug", now: fixedNow });

    logger.info("req-9", "hello");

    expect(lines).toEqual([`info [${FIXED_TIME}] [pid:42] [scope][trace:req-9]`]);
  });
});

describe("resolveDefaultMinLevel", () => {
  it("production 从 info 起，其余环境从 debug 起", () => {
    expect(resolveDefaultMinLevel("production")).toBe("info");
    expect(resolveDefaultMinLevel("production ")).toBe("info");
    expect(resolveDefaultMinLevel("test")).toBe("debug");
    expect(resolveDefaultMinLevel(undefined)).toBe("debug");
  });
});

describe("readTrimmedEnv", () => {
  it("去掉首尾空白，空串按未设置处理", () => {
    expect(readTrimmedEnv({ ZM_HOST: " 0.0.0.0 \n" }, "ZM_HOST")).toBe("0.0.0.0");
    expect(readTrimmedEnv({ ZM_HOST: "  " }, "ZM_HOST")).toBeUndefined();
    expect(readTrimmedEnv({}, "ZM_HOST")).toBeUndefined();
  });
});
