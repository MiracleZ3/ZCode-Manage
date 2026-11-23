import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

/** 夹具里的密钥、口令一律运行时随机生成：测试不关心取值，源码里也不出现凭据字面量。 */
function generateSecret(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

function createServiceClient() {
  return {
    clientId: "svc-dev",
    clientSecret: generateSecret(),
    redirectUris: [],
    grantTypes: ["client_credentials"],
    scope: "model:invoke",
    tokenEndpointAuthMethod: "client_secret_post",
  };
}

const INTERACTIVE_CLIENT = {
  clientId: "zcode-ee-dev",
  redirectUris: ["http://127.0.0.1:53682/callback"],
  grantTypes: ["authorization_code", "refresh_token"],
  scope: "openid model:invoke device:register",
  tokenEndpointAuthMethod: "none",
};

/** 能让 manage-api 启动的最小环境。 */
function createValidEnv(): NodeJS.ProcessEnv {
  return {
    ZM_DATABASE_URL: `postgres://zm:${generateSecret(6)}@127.0.0.1:5432/zm`,
    ZM_AUTH_STATE_KEY: generateSecret(24),
    ZM_OIDC_CLIENTS_JSON: JSON.stringify([createServiceClient(), INTERACTIVE_CLIENT]),
  };
}

/** 去掉一个变量，得到缺了必填项的环境。 */
function withoutEnv(name: string): NodeJS.ProcessEnv {
  const env = createValidEnv();
  delete env[name];
  return env;
}

function captureConfigError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig({ env });
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadConfig to throw ConfigError");
}

describe("loadConfig", () => {
  it("最小环境下使用各项默认值", () => {
    const config = loadConfig({ env: createValidEnv() });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      publicBaseUrl: "http://localhost:8080",
      gatewayBaseUrl: "http://localhost:8081",
      orgId: "org-dev",
      authAdapters: [],
      seedModels: [],
    });
    expect(config.oidcClients).toHaveLength(2);
    // 公共客户端在环境里没有给 clientSecret，配置里也就没有这个键。
    expect(config.oidcClients[1]).not.toHaveProperty("clientSecret");
  });

  it("环境变量里的首尾空白被去掉", () => {
    const config = loadConfig({
      env: {
        ...createValidEnv(),
        ZM_PORT: " 9000 \n",
        ZM_PUBLIC_BASE_URL: " http://zm.internal:9000 ",
      },
    });

    expect(config.port).toBe(9000);
    expect(config.publicBaseUrl).toBe("http://zm.internal:9000");
  });

  it("必填项缺失时直接抛错：数据库地址、签名密钥、客户端清单", () => {
    expect(() => loadConfig({ env: withoutEnv("ZM_DATABASE_URL") })).toThrow();
    expect(() => loadConfig({ env: withoutEnv("ZM_AUTH_STATE_KEY") })).toThrow();
    expect(() => loadConfig({ env: withoutEnv("ZM_OIDC_CLIENTS_JSON") })).toThrow();
  });

  it("签名密钥太短不行：state 的防伪造能力取决于它", () => {
    expect(() =>
      loadConfig({ env: { ...createValidEnv(), ZM_AUTH_STATE_KEY: "too-short" } }),
    ).toThrow();
  });

  it("端口不是整数或超出范围时抛错，进程不会带着错配置启动", () => {
    expect(() => loadConfig({ env: { ...createValidEnv(), ZM_PORT: "abc" } })).toThrow();
    expect(() => loadConfig({ env: { ...createValidEnv(), ZM_PORT: "70000" } })).toThrow();
  });

  it("JSON 环境变量不是合法 JSON 时，错误信息里写明是哪个变量", () => {
    expect(
      captureConfigError({ ...createValidEnv(), ZM_AUTH_ADAPTERS_JSON: "{not json" }).message,
    ).toContain("ZM_AUTH_ADAPTERS_JSON");
  });

  it("JSON 结构不合法时报出变量名与出问题的字段", () => {
    const message = captureConfigError({
      ...createValidEnv(),
      ZM_OIDC_CLIENTS_JSON: JSON.stringify([{ clientId: "x", redirectUris: "nope" }]),
    }).message;

    expect(message).toContain("ZM_OIDC_CLIENTS_JSON");
    expect(message).toContain("redirectUris");
  });

  it("适配器标识只接受小写字母、数字与连字符：它会出现在回调路径里", () => {
    const message = captureConfigError({
      ...createValidEnv(),
      ZM_AUTH_ADAPTERS_JSON: JSON.stringify([
        { id: "../evil", kind: "oidc-upstream", issuer: "http://idp.test", clientId: "c" },
      ]),
    }).message;

    expect(message).toContain("ZM_AUTH_ADAPTERS_JSON");
  });
});
