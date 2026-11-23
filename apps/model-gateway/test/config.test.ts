import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("没有任何环境变量时使用默认值", () => {
    expect(loadConfig({ env: {} })).toEqual({ host: "127.0.0.1", port: 8081, logLevel: undefined });
  });

  it("环境变量的首尾空白被去掉", () => {
    expect(loadConfig({ env: { ZM_HOST: " 0.0.0.0 \n", ZM_PORT: " 9000 " } })).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
    });
  });

  it("端口不是整数或超出范围时抛错，进程不会带着错配置启动", () => {
    expect(() => loadConfig({ env: { ZM_PORT: "abc" } })).toThrow();
    expect(() => loadConfig({ env: { ZM_PORT: "70000" } })).toThrow();
  });

  it("日志级别只接受四个级别", () => {
    expect(loadConfig({ env: { ZM_LOG_LEVEL: "warn" } }).logLevel).toBe("warn");
    expect(() => loadConfig({ env: { ZM_LOG_LEVEL: "verbose" } })).toThrow();
  });
});
