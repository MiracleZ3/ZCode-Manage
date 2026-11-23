import { formatLogPrefix } from "./log-format.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type TraceId = string;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/**
 * 第一个参数是 trace ID（通常是请求 ID），没有上下文时传 undefined。
 * 签名与 ZCode 的 ServiceLogger 一致，两个仓库的日志行可以放在一起检索。
 */
export interface Logger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface LoggerOptions {
  pid?: number;
  sink?: LoggerSink;
  /** 最低输出级别。不传时 production 从 info 起，其余环境从 debug 起。 */
  minLevel?: LogLevel;
  nodeEnv?: string;
  /** 仅供测试注入固定时间。 */
  now?: () => Date;
}

export function resolveDefaultMinLevel(nodeEnv: string | undefined): LogLevel {
  return nodeEnv?.trim() === "production" ? "info" : "debug";
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const pid = options.pid ?? process.pid;
  const sink = options.sink ?? console;
  // debug 的高频诊断只在非 production 输出，避免生产环境把它们落盘。
  const minLevel =
    options.minLevel ?? resolveDefaultMinLevel(options.nodeEnv ?? process.env["NODE_ENV"]);
  const now = options.now ?? (() => new Date());
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  function write(level: LogLevel, traceId: TraceId | undefined, ...args: unknown[]): void {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) {
      return;
    }
    const prefix = formatLogPrefix(scope, { pid, traceId, now: now() });
    const sinkFn =
      level === "error"
        ? sink.error
        : level === "warn"
          ? sink.warn
          : level === "debug"
            ? (sink.debug ?? sink.log)
            : sink.log;
    sinkFn(prefix, ...args);
  }

  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}
