import { REQUEST_ID_HEADER } from "@zm/shared";
import { describe, expect, it } from "vitest";
import { SERVICE_NAME, createApp } from "../src/app.js";

describe("model-gateway app", () => {
  it("健康检查返回服务名与版本，并回传请求 ID", async () => {
    const app = createApp();

    const response = await app.request("/healthz", {
      headers: { [REQUEST_ID_HEADER]: "req-health" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-health");
    expect(await response.json()).toEqual({
      status: "ok",
      service: SERVICE_NAME,
      version: "0.0.0-test",
    });
  });

  it("未匹配的路由返回统一错误体", async () => {
    const app = createApp();

    const response = await app.request("/not-a-route");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
