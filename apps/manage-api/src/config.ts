import { readTrimmedEnv } from "@zm/shared";
import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const configSchema = z
  .object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    logLevel: logLevelSchema.optional(),
  })
  .strict();

export type ManageApiConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * 配置只在进程启动时读取一次。非法值直接抛错，进程拒绝启动，不带着错配置运行。
 */
export function loadConfig(options: LoadConfigOptions = {}): ManageApiConfig {
  const env = options.env ?? process.env;
  return configSchema.parse({
    // 默认只绑回环地址；进容器时由编排显式设置监听地址。
    host: readTrimmedEnv(env, "ZM_HOST") ?? "127.0.0.1",
    port: readTrimmedEnv(env, "ZM_PORT") ?? 8080,
    logLevel: readTrimmedEnv(env, "ZM_LOG_LEVEL"),
  });
}
