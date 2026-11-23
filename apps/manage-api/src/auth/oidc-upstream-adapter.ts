import * as openidClient from "openid-client";
import type { RedirectAuthAdapter, RedirectStart } from "./auth-adapter.js";
import { isLoopbackIssuer, type AuthAdapterConfig } from "../config.js";

const UPSTREAM_SCOPE = "openid profile email";

export interface OidcUpstreamAdapterOptions {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /**
   * 允许用明文 HTTP 连接身份系统，只对本机回环地址有效，用途是本机开发。
   * 默认不允许。配置校验已经把过一道关，这里是第二道。
   */
  allowInsecureHttp?: boolean;
  /** 仅供测试替换上游发现。 */
  discover?: typeof openidClient.discovery;
}

/**
 * 标准 OIDC 上游适配器。连接客户的身份系统时启用 non-repudiation checks：
 * 不只解码 ID Token，还用上游的公钥验它的签名。
 */
export async function createOidcUpstreamAdapter(
  options: OidcUpstreamAdapterOptions,
): Promise<RedirectAuthAdapter> {
  const issuer = new URL(options.issuer);
  const insecureAllowed = options.allowInsecureHttp === true;
  if (issuer.protocol === "http:" && (!insecureAllowed || !isLoopbackIssuer(options.issuer))) {
    throw new Error(`upstream identity provider must use https: ${options.issuer}`);
  }

  const clientAuthentication = options.clientSecret
    ? openidClient.ClientSecretPost(options.clientSecret)
    : openidClient.None();
  const discover = options.discover ?? openidClient.discovery;
  // execute 里的函数会在配置实例创建后执行。allowInsecureRequests 关掉库自带的“只允许 HTTPS”限制。
  const execute = insecureAllowed ? [openidClient.allowInsecureRequests] : [];
  const configuration = await discover(issuer, options.clientId, undefined, clientAuthentication, {
    execute,
  });
  openidClient.enableNonRepudiationChecks(configuration);

  return {
    id: options.id,
    kind: "redirect",
    async buildAuthorizationUrl(input: {
      state: string;
      callbackUrl: string;
    }): Promise<RedirectStart> {
      const codeVerifier = openidClient.randomPKCECodeVerifier();
      const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);
      const url = openidClient.buildAuthorizationUrl(configuration, {
        redirect_uri: input.callbackUrl,
        scope: UPSTREAM_SCOPE,
        state: input.state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return { url: url.href, codeVerifier };
    },
    async finishLogin(input: { callbackUrl: URL; state: string; codeVerifier: string }) {
      // expectedState 缺省时库会要求“回调里没有 state”，所以这里必须显式传。
      const tokens = await openidClient.authorizationCodeGrant(configuration, input.callbackUrl, {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.state,
        idTokenExpected: true,
      });
      const sub = tokens.claims()?.sub;
      if (!sub) {
        // 没有主体标识就无法建档，也不能拿别的字段顶替。
        throw new Error("upstream ID token has no sub claim");
      }
      const userInfo = await openidClient.fetchUserInfo(configuration, tokens.access_token, sub);
      const profile = userInfo as { name?: unknown; preferred_username?: unknown; email?: unknown };
      return {
        subject: sub,
        displayName: pickDisplayName(profile) ?? sub,
        ...(typeof profile.email === "string" ? { email: profile.email } : {}),
      };
    },
  };
}

function pickDisplayName(profile: {
  name?: unknown;
  preferred_username?: unknown;
}): string | undefined {
  if (typeof profile.name === "string" && profile.name.trim()) {
    return profile.name.trim();
  }
  if (typeof profile.preferred_username === "string" && profile.preferred_username.trim()) {
    return profile.preferred_username.trim();
  }
  return undefined;
}

export function createAdaptersFromConfig(
  configs: AuthAdapterConfig[],
  overrides: Partial<Pick<OidcUpstreamAdapterOptions, "discover">> = {},
): Promise<RedirectAuthAdapter[]> {
  return Promise.all(
    configs.map((config) =>
      createOidcUpstreamAdapter({
        id: config.id,
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        allowInsecureHttp: config.allowInsecureHttp === true,
        ...overrides,
      }),
    ),
  );
}
