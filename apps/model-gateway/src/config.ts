import { readServiceConfig, readTrimmedEnv, serviceConfigSchema } from "@zm/shared";
import { z } from "zod";

const configSchema = serviceConfigSchema
  .extend({
    /** 管控平面的颁发者。网关用它的公钥验令牌，并核对令牌确实由它签发。 */
    issuer: z.url(),
    databaseUrl: z.string().min(1),
    /** 等上游响应头的最长时间，毫秒。超过即判定上游不可达。 */
    upstreamTimeoutMs: z.coerce.number().int().positive(),
  })
  .strict();
export type GatewayConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

/** 配置只在进程启动时读取一次。非法值直接抛错，进程拒绝启动。 */
export function loadConfig(options: LoadConfigOptions = {}): GatewayConfig {
  const env = options.env ?? process.env;
  return configSchema.parse({
    ...readServiceConfig({ env, defaultPort: 8081 }),
    issuer: readTrimmedEnv(env, "ZM_ISSUER") ?? "http://localhost:8080",
    databaseUrl: readTrimmedEnv(env, "ZM_DATABASE_URL"),
    upstreamTimeoutMs: readTrimmedEnv(env, "ZM_UPSTREAM_TIMEOUT_MS") ?? 60_000,
  });
}
