import { apiErrorSchema, type AccessTokenClaims } from "@zm/contracts";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono/types";
import type { ServiceAppEnv } from "./http.js";
import {
  hasScope,
  readBearerToken,
  type AccessTokenVerifier,
  type TokenRejectReason,
} from "./token-verify.js";

export type AuthEnv = ServiceAppEnv & { Variables: { claims: AccessTokenClaims } };

export interface AuthMiddlewareOptions {
  verify: AccessTokenVerifier;
  /** 令牌被拒时的回调，用来记日志。 */
  onRejected?: (input: { requestId: string; reason: TokenRejectReason }) => void;
}

export interface AuthMiddleware {
  /** 要求带有效的 Bearer 令牌；通过后把声明放进上下文。 */
  requireToken: MiddlewareHandler<AuthEnv>;
  /** 要求令牌范围里包含指定的那一个。必须挂在 requireToken 之后。 */
  requireScope: (scope: string) => MiddlewareHandler<AuthEnv>;
}

const CHALLENGE_MISSING = 'Bearer realm="zcode-manage"';
// 不在 WWW-Authenticate 里写具体原因，避免向调用方泄露“令牌存在但过期”之类的信息。
const CHALLENGE_INVALID = 'Bearer realm="zcode-manage", error="invalid_token"';

function unauthorized(c: Context<AuthEnv>, challenge: string): Response {
  c.header("WWW-Authenticate", challenge);
  return c.json(
    apiErrorSchema.parse({
      error: { code: "unauthorized", message: "Unauthorized", requestId: c.get("requestId") },
    }),
    401,
  );
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): AuthMiddleware {
  const requireToken: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const token = readBearerToken(c.req.header("authorization"));
    if (!token) {
      return unauthorized(c, CHALLENGE_MISSING);
    }
    const result = await options.verify(token);
    if (!result.ok) {
      options.onRejected?.({ requestId: c.get("requestId"), reason: result.reason });
      return unauthorized(c, CHALLENGE_INVALID);
    }
    c.set("claims", result.claims);
    await next();
  };

  const requireScope =
    (scope: string): MiddlewareHandler<AuthEnv> =>
    async (c, next) => {
      const claims = c.get("claims");
      if (!claims) {
        // 走到这里说明路由挂载顺序写错了，是程序缺陷，不是调用方的问题。
        throw new Error("requireScope must be mounted after requireToken");
      }
      if (!hasScope(claims, scope)) {
        return c.json(
          apiErrorSchema.parse({
            error: {
              code: "insufficient_scope",
              message: "Forbidden",
              requestId: c.get("requestId"),
            },
          }),
          403,
        );
      }
      await next();
    };

  return { requireToken, requireScope };
}

/** 取当前请求的访问令牌声明。调用它的路由必须挂了 requireToken。 */
export function getClaims(c: Context<AuthEnv>): AccessTokenClaims {
  const claims = c.get("claims");
  if (!claims) {
    throw new Error("no access token on request; mount requireToken first");
  }
  return claims;
}
