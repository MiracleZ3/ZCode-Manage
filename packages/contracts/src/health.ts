import { z } from "zod";

/**
 * 每个服务的健康检查响应。它只表示进程能应答，不表示数据库等依赖可用；
 * 就绪检查在接入数据库之后另行定义。
 */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
