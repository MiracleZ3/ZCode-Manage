import { readServiceConfig, serviceConfigSchema } from "@zm/shared";
import { z } from "zod";

const oidcClientConfigSchema = z
  .object({
    clientId: z.string().min(1),
    // 公共客户端不填。
    clientSecret: z.string().min(1).optional(),
    redirectUris: z.array(z.url()),
    // 退出登录之后允许把浏览器带回的地址。只有浏览器里用的客户端（控制台）用得到，其余客户端留空。
    // 和登录回调一样必须逐个登记，没登记的会被结束会话端点拒绝。
    postLogoutRedirectUris: z.array(z.url()).default([]),
    grantTypes: z
      .array(z.enum(["authorization_code", "refresh_token", "client_credentials"]))
      .min(1),
    // 空格分隔的允许范围。
    scope: z.string().min(1),
    tokenEndpointAuthMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]),
  })
  .strict();
export type OidcClientConfig = z.infer<typeof oidcClientConfigSchema>;

/** 只有这些主机名算“本机回环地址”。明文 HTTP 的身份系统只对它们开放。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 本期只有“标准 OIDC 上游”一种适配器。
 * kind 字段留着给以后的第二种（客户提供校验账号口令的接口）做判别。
 */
const authAdapterConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    kind: z.literal("oidc-upstream"),
    issuer: z.url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    /**
     * 允许用明文 HTTP 连接身份系统。默认不允许：真实部署里客户的身份系统必须走 HTTPS。
     * 打开它也只对本机回环地址有效，用途是本机开发。
     */
    allowInsecureHttp: z.boolean().optional(),
  })
  .strict()
  .superRefine((adapter, ctx) => {
    const issuer = new URL(adapter.issuer);
    if (issuer.protocol !== "http:") {
      return;
    }
    if (!adapter.allowInsecureHttp) {
      ctx.addIssue({
        code: "custom",
        message: "身份系统的地址必须是 https；本机开发用的回环地址需显式设置 allowInsecureHttp",
      });
    } else if (!LOOPBACK_HOSTS.has(issuer.hostname)) {
      ctx.addIssue({ code: "custom", message: "allowInsecureHttp 只对本机回环地址有效" });
    }
  });
export type AuthAdapterConfig = z.infer<typeof authAdapterConfigSchema>;

export function isLoopbackIssuer(issuer: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(issuer).hostname);
}

const seedModelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    contextWindow: z.number().int().positive(),
    endpointId: z.string().min(1),
    baseUrl: z.url(),
    upstreamModel: z.string().min(1),
  })
  .strict();
export type SeedModelConfig = z.infer<typeof seedModelSchema>;

const configSchema = serviceConfigSchema
  .extend({
    publicBaseUrl: z.url(),
    databaseUrl: z.string().min(1),
    gatewayBaseUrl: z.url(),
    minimalClientVersion: z.string().min(1),
    heartbeatIntervalSeconds: z.coerce.number().int().positive(),
    orgId: z.string().min(1),
    oidcClients: z.array(oidcClientConfigSchema).min(1),
    authAdapters: z.array(authAdapterConfigSchema),
    seedModels: z.array(seedModelSchema),
    // 不给时每次启动生成新的开发密钥，重启后旧令牌全部失效。
    oidcJwksFile: z.string().min(1).optional(),
    // 用来给登录过程中的 state 加签，防止跨站伪造回调。
    authStateKey: z.string().min(16),
  })
  .strict();
export type ManageApiConfig = z.infer<typeof configSchema>;

/** 某个环境变量的内容不对。错误信息里写明变量名，便于在部署环境里定位。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * 复杂结构用 JSON 字符串放在一个环境变量里。
 * 解析失败时报出变量名，而不是一串 zod 的内部路径。
 */
function parseJsonEnv<T>(
  env: NodeJS.ProcessEnv,
  name: string,
  schema: z.ZodType<T>,
): T | undefined {
  const raw = readTrimmed(env, name);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${name} 不是合法的 JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `${name} 的结构不合法：${result.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("；")}`,
    );
  }
  return result.data;
}

/** 配置只在进程启动时读取一次。非法值直接抛错，进程拒绝启动。 */
export function loadConfig(options: LoadConfigOptions = {}): ManageApiConfig {
  const env = options.env ?? process.env;
  const oidcClientsSchema = z.array(oidcClientConfigSchema).min(1);
  return configSchema.parse({
    ...readServiceConfig({ env, defaultPort: 8080 }),
    publicBaseUrl: readTrimmed(env, "ZM_PUBLIC_BASE_URL") ?? "http://localhost:8080",
    databaseUrl: readTrimmed(env, "ZM_DATABASE_URL"),
    gatewayBaseUrl: readTrimmed(env, "ZM_GATEWAY_BASE_URL") ?? "http://localhost:8081",
    minimalClientVersion: readTrimmed(env, "ZM_MINIMAL_CLIENT_VERSION") ?? "0.0.0",
    heartbeatIntervalSeconds: readTrimmed(env, "ZM_HEARTBEAT_INTERVAL_SECONDS") ?? 60,
    orgId: readTrimmed(env, "ZM_ORG_ID") ?? "org-dev",
    oidcClients: parseJsonEnv(env, "ZM_OIDC_CLIENTS_JSON", oidcClientsSchema),
    authAdapters:
      parseJsonEnv(env, "ZM_AUTH_ADAPTERS_JSON", z.array(authAdapterConfigSchema)) ?? [],
    seedModels: parseJsonEnv(env, "ZM_SEED_MODELS_JSON", z.array(seedModelSchema)) ?? [],
    oidcJwksFile: readTrimmed(env, "ZM_OIDC_JWKS_FILE"),
    authStateKey: readTrimmed(env, "ZM_AUTH_STATE_KEY"),
  });
}
