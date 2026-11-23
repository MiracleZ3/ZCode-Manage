import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { apiErrorSchema, healthResponseSchema } from "@zm/contracts";
import { createLogger, type Logger } from "./logger.js";

/** 与 ZCode 的 ApiClient 用同一个请求头，两个仓库的日志可以按请求 ID 对上。 */
export const REQUEST_ID_HEADER = "x-request-id";

// 请求 ID 会写进日志和响应头：只接受可见 ASCII，长度设上限，防止控制字符和超长值。
const REQUEST_ID_PATTERN = /^[\x21-\x7e]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

export interface BaseServiceAppOptions {
  service: string;
  version: string;
  logger?: Logger;
}

export type ServiceAppEnv = { Variables: { requestId: string } };

export function resolveRequestId(headerValue: string | undefined): string {
  const candidate = headerValue?.trim();
  if (
    candidate &&
    candidate.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(candidate)
  ) {
    return candidate;
  }
  return randomUUID();
}

/**
 * 每个服务的 Hono 骨架：请求 ID、健康检查、统一的 404 与未捕获错误出口。
 * 业务路由由各服务在返回的 app 上继续注册。
 * 类型参数 E 让服务追加自己的上下文变量，例如访问令牌的声明。
 */
export function createBaseApp<E extends ServiceAppEnv>(options: BaseServiceAppOptions): Hono<E> {
  const service = options.service.trim();
  const logger = options.logger ?? createLogger(`${service}:http`);
  const app = new Hono<E>();

  function errorBody(code: string, message: string, c: Context<E>) {
    return apiErrorSchema.parse({ error: { code, message, requestId: c.get("requestId") } });
  }

  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
    // 模型网关的请求量大，访问日志放 debug，生产环境默认不输出。
    logger.debug(
      requestId,
      `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Math.round(performance.now() - startedAt)}ms`,
    );
  });

  app.get("/healthz", (c) =>
    c.json(healthResponseSchema.parse({ status: "ok", service, version: options.version })),
  );

  app.notFound((c) => c.json(errorBody("not_found", "Not Found", c), 404));

  // 统一错误出口：不把内部细节返回给调用方，细节只进日志，凭请求 ID 定位。
  app.onError((error, c) => {
    const requestId = c.get("requestId");
    logger.error(requestId, "unhandled request error", error);
    return c.json(errorBody("internal_error", "Internal Server Error", c), 500);
  });

  return app;
}
