import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AccessTokenClaims } from "@zm/contracts";
import {
  createAuthMiddleware,
  type AuthEnv,
  type TokenRejectReason,
  type TokenVerification,
} from "../src/index.js";

const CLAIMS: AccessTokenClaims = {
  sub: "user-1",
  client_id: "zcode-ee-dev",
  scope: "openid model:invoke",
  "zm:accountType": "user",
  "zm:displayName": "Alice",
  "zm:orgId": "org-dev",
};

function createTestApp(options: {
  verify?: (token: string) => Promise<TokenVerification>;
  scope?: string;
  tokenRequired?: boolean;
}) {
  const rejected: { requestId: string; reason: TokenRejectReason }[] = [];
  const verify =
    options.verify ??
    (async (token: string): Promise<TokenVerification> =>
      token === "good" ? { ok: true, claims: CLAIMS } : { ok: false, reason: "signature" });
  const auth = createAuthMiddleware({ verify, onRejected: (input) => rejected.push(input) });

  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    await next();
  });
  // tokenRequired 为 false 时刻意把范围检查挂在令牌检查前面，模拟路由挂载顺序写错的情形。
  if (options.tokenRequired !== false) {
    app.use("/protected", auth.requireToken);
  }
  if (options.scope) {
    app.use("/protected", auth.requireScope(options.scope));
  }
  app.get("/protected", (c) => c.json({ sub: c.get("claims").sub }));
  app.onError((error) => new Response(String(error), { status: 500 }));
  return { app, rejected };
}

describe("createAuthMiddleware", () => {
  it("有效令牌：声明进了上下文，业务路由直接可用", async () => {
    const { app } = createTestApp({});
    const response = await app.request("/protected", { headers: { authorization: "Bearer good" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: "user-1" });
  });

  it("没有令牌、令牌无效：都是 401，并带上 WWW-Authenticate", async () => {
    const { app, rejected } = createTestApp({});
    const missing = await app.request("/protected");
    const invalid = await app.request("/protected", { headers: { authorization: "Bearer bad" } });

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="zcode-manage"');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // 对外不区分原因；原因只交给回调去记日志。
    expect(await invalid.json()).toEqual({
      error: { code: "unauthorized", message: "Unauthorized", requestId: "req-1" },
    });
    expect(rejected).toEqual([{ requestId: "req-1", reason: "signature" }]);
  });

  it("令牌有效但缺范围：403", async () => {
    const { app } = createTestApp({ scope: "usage:read" });
    const response = await app.request("/protected", { headers: { authorization: "Bearer good" } });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "insufficient_scope", requestId: "req-1" },
    });
  });

  it("所需的范围在令牌里：放行", async () => {
    const { app } = createTestApp({ scope: "model:invoke" });
    const response = await app.request("/protected", { headers: { authorization: "Bearer good" } });

    expect(response.status).toBe(200);
  });

  it("范围检查挂在令牌检查之前是程序缺陷：得到 500，而不是放行", async () => {
    const { app } = createTestApp({ scope: "model:invoke", tokenRequired: false });
    const response = await app.request("/protected", { headers: { authorization: "Bearer good" } });

    expect(response.status).toBe(500);
  });

  it("校验器自己抛异常时得到 500，不会被当成“令牌无效”", async () => {
    const { app, rejected } = createTestApp({
      verify: async () => {
        throw new Error("jwks unreachable");
      },
    });
    const response = await app.request("/protected", { headers: { authorization: "Bearer good" } });

    expect(response.status).toBe(500);
    expect(rejected).toEqual([]);
  });
});
