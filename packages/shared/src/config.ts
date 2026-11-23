import { readTrimmedEnv } from "./env.js";
import { z } from "zod";

/**
 * 每个服务共有的配置。应用自己的配置在此基础上用 `.extend()` 追加，
 * 端口默认值由各应用给出，避免三个应用都挤在同一个端口上。
 */
export const serviceConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
  })
  .strict();
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export interface ReadServiceConfigOptions {
  env?: NodeJS.ProcessEnv;
  defaultPort: number;
}

/**
 * 配置只在进程启动时读取一次。非法值直接抛错，进程拒绝启动，不带着错配置运行。
 */
export function readServiceConfig(options: ReadServiceConfigOptions): ServiceConfig {
  const env = options.env ?? process.env;
  return serviceConfigSchema.parse({
    // 默认只绑回环地址；进容器时由编排显式设置监听地址。
    host: readTrimmedEnv(env, "ZM_HOST") ?? "127.0.0.1",
    port: readTrimmedEnv(env, "ZM_PORT") ?? options.defaultPort,
    logLevel: readTrimmedEnv(env, "ZM_LOG_LEVEL"),
  });
}
