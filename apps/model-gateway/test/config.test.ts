import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** 数据库地址里的口令运行时随机生成，源码里不出现凭据字面量。 */
function createValidEnv(): NodeJS.ProcessEnv {
  return { ZM_DATABASE_URL: `postgres://zm:${randomBytes(6).toString("hex")}@127.0.0.1:5432/zm` };
}

describe("loadConfig", () => {
  it("默认监听 8081，颁发者指向本机的 manage-api", () => {
    expect(loadConfig({ env: createValidEnv() })).toMatchObject({
      host: "127.0.0.1",
      port: 8081,
      issuer: "http://localhost:8080",
      upstreamTimeoutMs: 60_000,
    });
  });

  it("环境变量里的首尾空白被去掉", () => {
    const config = loadConfig({
      env: {
        ...createValidEnv(),
        ZM_HOST: " 0.0.0.0 \n",
        ZM_PORT: " 9000 ",
        ZM_ISSUER: " http://zm.internal:8080 ",
      },
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      issuer: "http://zm.internal:8080",
    });
  });

  it("数据库地址是必填项", () => {
    expect(() => loadConfig({ env: {} })).toThrow();
  });

  it("端口不是整数或超出范围时抛错，进程不会带着错配置启动", () => {
    expect(() => loadConfig({ env: { ...createValidEnv(), ZM_PORT: "abc" } })).toThrow();
    expect(() => loadConfig({ env: { ...createValidEnv(), ZM_PORT: "70000" } })).toThrow();
  });

  it("日志级别与上游超时只接受合法取值", () => {
    expect(loadConfig({ env: { ...createValidEnv(), ZM_LOG_LEVEL: "warn" } }).logLevel).toBe(
      "warn",
    );
    expect(() => loadConfig({ env: { ...createValidEnv(), ZM_LOG_LEVEL: "verbose" } })).toThrow();
    expect(
      loadConfig({ env: { ...createValidEnv(), ZM_UPSTREAM_TIMEOUT_MS: "1500" } })
        .upstreamTimeoutMs,
    ).toBe(1500);
    expect(() =>
      loadConfig({ env: { ...createValidEnv(), ZM_UPSTREAM_TIMEOUT_MS: "0" } }),
    ).toThrow();
  });
});
