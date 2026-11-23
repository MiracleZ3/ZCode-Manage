export interface LogPrefixOptions {
  pid?: number;
  traceId?: string;
  now?: Date;
}

/**
 * 日志行前缀，与 ZCode 服务端保持同一种版式：
 * 无 trace: "[时间] [pid:12345] [scope]"
 * 带 trace: "[时间] [pid:12345] [scope][trace:abc]"
 *
 * 时间戳用 ISO 8601 UTC，这一点与 ZCode 的本地时间写法不同：管控平面的日志来自
 * 多个容器，本地时间在跨时区聚合时无法对齐。
 */
export function formatLogPrefix(scope: string, options: LogPrefixOptions = {}): string {
  const { pid, traceId, now = new Date() } = options;
  const pidPart = pid != null ? ` [pid:${pid}]` : "";
  const tracePart = traceId ? `[trace:${traceId}]` : "";
  return `[${now.toISOString()}]${pidPart} [${scope}]${tracePart}`;
}
