import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify } from "jose";
import { accessTokenClaimsSchema, type AccessTokenClaims, parseScopes } from "@zm/contracts";

export const OIDC_PATH_PREFIX = "/connect";

/**
 * 本期唯一的资源：管控平面自己的接口，也就是管理接口与网关。
 * 颁发者把它写进令牌的受众，验令牌的一方核对它。两边用同一个函数算，格式只在这里定义一次。
 */
export function apiResourceIdentifier(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/api`;
}

/** 签名算法白名单。不让令牌头部自己说了算，避免算法混淆攻击。 */
const ALLOWED_ALGORITHMS = ["RS256", "RS384", "ES256", "ES384", "EdDSA"];

export interface AccessTokenVerifierOptions {
  /** OIDC 颁发者，用来校验 iss。 */
  issuer: string;
  /** 公钥地址。默认取颁发者下的 /connect/jwks。 */
  jwksUri?: string;
  /**
   * 令牌必须具备的受众，默认是颁发者下的 api 资源。
   * 这一项总是参与核对：颁发者以后签发给别的资源的令牌，不该在这里被接受。
   */
  audience?: string;
  /**
   * 公钥的缓存时间，秒。上游响应没有缓存头时使用；
   * 之后轮换公钥，旧公钥最多这么久还在被信任。
   */
  cacheMaxAgeSeconds?: number;
  /** 仅供测试替换网络访问。 */
  fetchFn?: typeof fetch;
}

export type TokenRejectReason =
  | "malformed"
  | "signature"
  | "expired"
  | "issuer"
  | "audience"
  | "missing_claims";

export type TokenVerification =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: TokenRejectReason };

export type AccessTokenVerifier = (token: string) => Promise<TokenVerification>;

/**
 * 用颁发者的公钥在本地验令牌。管理端与网关共用这一份判定，
 * 所以“令牌无效”在两边永远是同一个意思。任何失败都归到有限的几种原因里，细节不外传。
 */
export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerifier {
  const jwksUri = options.jwksUri ?? `${options.issuer}${OIDC_PATH_PREFIX}/jwks`;
  const keyResolver = createRemoteJWKSet(new URL(jwksUri), {
    [customFetch]: options.fetchFn ?? fetch,
    cooldownDuration: (options.cacheMaxAgeSeconds ?? 300) * 1000,
  });

  return async function verify(token: string): Promise<TokenVerification> {
    let payload: unknown;
    try {
      const result = await jwtVerify(token, keyResolver, {
        issuer: options.issuer,
        audience: options.audience ?? apiResourceIdentifier(options.issuer),
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: "5s",
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        return { ok: false, reason: "expired" };
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        // 只认得出颁发者与受众这两种；其余声明不是这里约定的，归为不可用。
        if (error.claim === "iss") {
          return { ok: false, reason: "issuer" };
        }
        if (error.claim === "aud") {
          return { ok: false, reason: "audience" };
        }
        return { ok: false, reason: "malformed" };
      }
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
        return { ok: false, reason: "signature" };
      }
      // 其余情况：不是 JWT、头部损坏、算法不在白名单、公钥暂时取不到。
      return { ok: false, reason: "malformed" };
    }
    const parsed = accessTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: "missing_claims" };
    }
    return { ok: true, claims: parsed.data };
  };
}

/** 令牌的范围里是否包含所需的那一个。 */
export function hasScope(claims: AccessTokenClaims, scope: string): boolean {
  return parseScopes(claims.scope).has(scope);
}

/** 从 Authorization 请求头取 Bearer 令牌。格式不对返回 undefined。 */
export function readBearerToken(authorization: string | undefined): string | undefined {
  const value = authorization?.trim();
  if (!value) {
    return undefined;
  }
  const parts = value.split(/\s+/);
  const [scheme, token] = parts;
  if (parts.length !== 2 || scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }
  return token;
}
