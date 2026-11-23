import { readServiceConfig, readTrimmedEnv, serviceConfigSchema } from "@zm/shared";
import { z } from "zod";

const configSchema = serviceConfigSchema
  .extend({
    /** 上游密钥只是个占位：替身服务会拒绝 Authorization 不对的请求，用来检验网关确实替换了凭证。 */
    apiKey: z.string().min(1),
    /** 每个流式数据块之间的间隔，毫秒。取 0 可以让测试跑得更快。 */
    streamChunkDelayMs: z.coerce.number().int().min(0),
  })
  .strict();
export type MockModelConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

/** 配置只在进程启动时读取一次。非法值直接抛错，进程拒绝启动。 */
export function loadConfig(options: LoadConfigOptions = {}): MockModelConfig {
  const env = options.env ?? process.env;
  return configSchema.parse({
    ...readServiceConfig({ env, defaultPort: 8082 }),
    apiKey: readTrimmedEnv(env, "ZM_MOCK_API_KEY") ?? "mock-dev-key",
    streamChunkDelayMs: readTrimmedEnv(env, "ZM_MOCK_STREAM_CHUNK_DELAY_MS") ?? 20,
  });
}
