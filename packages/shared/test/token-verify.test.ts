import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { AccessTokenClaims } from "@zm/contracts";
import {
  apiResourceIdentifier,
  createAccessTokenVerifier,
  hasScope,
  readBearerToken,
} from "../src/index.js";

const ISSUER = "http://manage.test";
/** 颁发者写进令牌的受众，也是验签的一方默认核对的那个值。 */
const API_RESOURCE = apiResourceIdentifier(ISSUER);

const CLAIMS: AccessTokenClaims = {
  sub: "user-1",
  client_id: "zcode-ee-dev",
  scope: "openid model:invoke device:register",
  "zm:accountType": "user",
  "zm:displayName": "Alice",
  "zm:orgId": "org-dev",
};

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/** 一个只提供公钥的假地址：校验器会自己来取，这里顺便断言它取对了地方。 */
function jwksFetcher(key: KeyPair): typeof fetch {
  return async (input) => {
    expect(String(input)).toBe(`${ISSUER}/connect/jwks`);
    return new Response(JSON.stringify({ keys: [await exportJWK(key.publicKey)] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

interface SignOptions {
  alg?: "RS256" | "ES256" | "EdDSA";
  issuer?: string;
  /** 给 null 表示不写受众。 */
  audience?: string | string[] | null;
  expiresIn?: string | number;
}

async function signToken(
  key: KeyPair,
  claims: Record<string, unknown>,
  options: SignOptions = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? "RS256" })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  const audience = options.audience === undefined ? API_RESOURCE : options.audience;
  return (audience === null ? jwt : jwt.setAudience(audience)).sign(key.privateKey);
}

describe("apiResourceIdentifier", () => {
  it("颁发者末尾有没有斜杠，算出的资源标识都一样", () => {
    expect(API_RESOURCE).toBe("http://manage.test/api");
    expect(apiResourceIdentifier(`${ISSUER}/`)).toBe(API_RESOURCE);
  });
});

describe("readBearerToken", () => {
  it("只接受“Bearer 加一个令牌”的写法，大小写不敏感", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
    expect(readBearerToken("  bearer   abc  ")).toBe("abc");
    expect(readBearerToken("Basic abc")).toBeUndefined();
    expect(readBearerToken("Bearer")).toBeUndefined();
    expect(readBearerToken("Bearer a b")).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
  });
});

describe("createAccessTokenVerifier", () => {
  it("验签通过，并按契约解析出声明", async () => {
    const key = await generateKeyPair("RS256");
    const verify = createAccessTokenVerifier({ issuer: ISSUER, fetchFn: jwksFetcher(key) });

    const result = await verify(await signToken(key, CLAIMS));

    expect(result).toEqual({ ok: true, claims: CLAIMS as AccessTokenClaims });
  });

  it("范围按整段匹配，不接受前缀", () => {
    expect(hasScope(CLAIMS, "model:invoke")).toBe(true);
    expect(hasScope(CLAIMS, "model")).toBe(false);
    expect(hasScope(CLAIMS, "device:register")).toBe(true);
  });

  it("签名不对、签发方不对、已过期、归属字段缺失，分别给出来因", async () => {
    const key = await generateKeyPair("RS256");
    const otherKey = await generateKeyPair("RS256");
    const verify = createAccessTokenVerifier({ issuer: ISSUER, fetchFn: jwksFetcher(key) });

    expect(await verify(await signToken(otherKey, CLAIMS))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verify(await signToken(key, CLAIMS, { issuer: "http://evil.test" }))).toEqual({
      ok: false,
      reason: "issuer",
    });
    expect(await verify(await signToken(key, CLAIMS, { expiresIn: -10 }))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verify(await signToken(key, { client_id: "x", scope: "openid" }))).toEqual({
      ok: false,
      reason: "missing_claims",
    });
  });

  it("受众不是本颁发者的 api 资源，或者根本没写受众：一律拒绝", async () => {
    const key = await generateKeyPair("RS256");
    const verify = createAccessTokenVerifier({ issuer: ISSUER, fetchFn: jwksFetcher(key) });

    // 签名和颁发者都是真的：这张令牌确实是本颁发者签的，只是签给别的资源。
    expect(
      await verify(await signToken(key, CLAIMS, { audience: "http://manage.test/another-api" })),
    ).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(await verify(await signToken(key, CLAIMS, { audience: null }))).toEqual({
      ok: false,
      reason: "audience",
    });

    // 列表里含本资源也算数，这是 JWT 受众写法的另一种形式。
    expect(
      await verify(await signToken(key, CLAIMS, { audience: [API_RESOURCE, "urn:other"] })),
    ).toMatchObject({
      ok: true,
    });
  });

  it("部署方可以指定别的受众，用来核对同一个颁发者签给其他资源的令牌", async () => {
    const key = await generateKeyPair("RS256");
    const verify = createAccessTokenVerifier({
      issuer: ISSUER,
      audience: "urn:zm:console",
      fetchFn: jwksFetcher(key),
    });

    expect(
      await verify(await signToken(key, CLAIMS, { audience: "urn:zm:console" })),
    ).toMatchObject({ ok: true });
    expect(await verify(await signToken(key, CLAIMS))).toEqual({ ok: false, reason: "audience" });
  });

  it("不是 JWT，或用了白名单之外的签名算法，一律按不可用处理", async () => {
    const key = await generateKeyPair("RS256");
    const verify = createAccessTokenVerifier({ issuer: ISSUER, fetchFn: jwksFetcher(key) });
    const hs256 = await new SignJWT(CLAIMS)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("secret"));

    expect(await verify("not-a-jwt")).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(hs256)).toEqual({ ok: false, reason: "malformed" });
  });

  it("ES256 与 EdDSA 也在白名单里", async () => {
    for (const alg of ["ES256", "EdDSA"] as const) {
      const key = await generateKeyPair(alg);
      const verify = createAccessTokenVerifier({ issuer: ISSUER, fetchFn: jwksFetcher(key) });

      expect(await verify(await signToken(key, CLAIMS, { alg }))).toMatchObject({
        ok: true,
        claims: { sub: "user-1" },
      });
    }
  });

  it("公钥地址不合法时在创建阶段就报错，而不是等到第一个请求", () => {
    expect(() => createAccessTokenVerifier({ issuer: "not a url" })).toThrow();
  });
});
