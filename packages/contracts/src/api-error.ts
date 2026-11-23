import { z } from "zod";

/**
 * 管理平面全部接口的错误体。成功时直接返回资源本身，不包一层信封；
 * 失败时用这个结构，调用方按 code 分支，凭 requestId 到日志里定位。
 */
export const apiErrorBodySchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().min(1),
  })
  .strict();

export const apiErrorSchema = z.object({ error: apiErrorBodySchema }).strict();

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
