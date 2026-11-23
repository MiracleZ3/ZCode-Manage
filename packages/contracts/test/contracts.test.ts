import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "../src/index.js";

describe("healthResponseSchema", () => {
  it("接受完整响应", () => {
    const body = { status: "ok", service: "manage-api", version: "1.2.3" } as const;

    expect(healthResponseSchema.parse(body)).toEqual(body);
  });

  it("拒绝未知字段", () => {
    expect(
      healthResponseSchema.safeParse({ status: "ok", service: "a", version: "1", extra: true })
        .success,
    ).toBe(false);
  });

  it("拒绝非 ok 状态", () => {
    expect(
      healthResponseSchema.safeParse({ status: "degraded", service: "a", version: "1" }).success,
    ).toBe(false);
  });
});

describe("apiErrorSchema", () => {
  it("接受带请求 ID 的错误体", () => {
    const body = {
      error: { code: "internal_error", message: "Internal Server Error", requestId: "req-1" },
    } as const;

    expect(apiErrorSchema.parse(body)).toEqual(body);
  });

  it("缺少 requestId 时不通过，保证每个错误都能在日志里定位", () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: "internal_error", message: "x" } }).success,
    ).toBe(false);
  });
});
