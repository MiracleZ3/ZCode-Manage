import { z } from "zod";

/** 客户端可见的错误码。HTTP 状态与 code 的对应关系见规格第 8 节。 */
export const errorCodeSchema = z.enum([
  "not_found",
  "unauthorized",
  "insufficient_scope",
  "model_not_found",
  "upstream_error",
  "validation_error",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const uuidSchema = z.uuid();

/** 一律是 ISO 8601 的 UTC 时间，精确到毫秒，例如 2026-11-23T10:00:00.000Z。 */
export const instantSchema = z.iso.datetime();
export type Instant = z.infer<typeof instantSchema>;

/** 游标是不透明的字符串；调用方原样回传，不解析。 */
export const cursorSchema = z.string().min(1).max(1024);
