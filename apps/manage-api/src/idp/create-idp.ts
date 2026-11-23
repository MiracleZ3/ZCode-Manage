import { readFile } from "node:fs/promises";
import { customScopes } from "@zm/contracts";
import {
  apiResourceIdentifier,
  createLogger,
  type InterceptHandler,
  type Logger,
} from "@zm/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider from "oidc-provider";
import type { ClientMetadata, Configuration } from "oidc-provider";
import type { RedirectAuthAdapter } from "../auth/auth-adapter.js";
import type { OidcClientConfig } from "../config.js";
import {
  type AuthTransaction,
  buildSetCookie,
  createLoginState,
  openAuthTransaction,
  readCookie,
  sealAuthTransaction,
} from "./state-cookie.js";
import { PAGE_CSP, errorPage, logoutConfirmationPage } from "./pages.js";

/** oidc-provider 为 client_credentials 保留的范围名；客户端元数据里必须带上它。 */
const CLIENT_CREDENTIALS_SCOPE = ".ClientCredentials";

const TRANSACTION_COOKIE = "zm_auth_txn";
/** 登录流程从跳出到回调的有效期。超过就算失败，用户重来。 */
const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

const INTERACTION_PATH_PREFIX = "/interaction/";
const CALLBACK_PATH_PREFIX = "/auth/callback/";
const DISCOVERY_PATH = "/.well-known/openid-configuration";

export interface IdpAccount {
  id: string;
  displayName: string;
}

export interface IdpOptions {
  issuer: string;
  clients: OidcClientConfig[];
  orgId: string;
  adapters: RedirectAuthAdapter[];
  /** 给登录过程的 state 加签用的密钥。 */
  stateKey: string;
  /** issuance 地址是 https 时才给状态 Cookie 加 Secure。 */
  secureCookies: boolean;
  findAccount: (accountId: string) => Promise<IdpAccount | undefined>;
  /** 首次登录自动建档。 */
  upsertUser: (input: {
    adapterId: string;
    identity: { subject: string; displayName: string; email?: string };
  }) => Promise<IdpAccount>;
  logger?: Logger;
  /** 不给时每次启动生成新的开发密钥，重启后旧令牌全部失效。 */
  jwksFile?: string;
}

export interface IdpService {
  /**
   * 接管 OIDC 端点与登录交互两条路径。其余路径不接管，交给 Hono。
   * 这些处理器直接写 Node 原生响应，所以不能经过 Hono 的适配器。
   */
  intercept: (pathname: string) => InterceptHandler | undefined;
}

function toOidcClientMetadata(client: OidcClientConfig): ClientMetadata {
  const grantTypes = [...client.grantTypes];
  const scopes = new Set(client.scope.split(/\s+/).filter((scope) => scope.length > 0));
  if (grantTypes.includes("client_credentials")) {
    scopes.add(CLIENT_CREDENTIALS_SCOPE);
  }
  const metadata: ClientMetadata = {
    client_id: client.clientId,
    redirect_uris: client.redirectUris,
    grant_types: grantTypes,
    response_types: grantTypes.includes("authorization_code") ? ["code"] : [],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: [...scopes].join(" "),
    // 没有登记任何回跳地址的客户端不写这一项，写入空数组没有意义。
    ...(client.postLogoutRedirectUris.length > 0
      ? { post_logout_redirect_uris: client.postLogoutRedirectUris }
      : {}),
  };
  return client.clientSecret ? { ...metadata, client_secret: client.clientSecret } : metadata;
}

/**
 * 管控平面自己的 OIDC Provider。客户端只对接它；它把“用户是谁”这个问题
 * 交给鉴权适配器去问客户身份系统。
 */
export async function createIdp(options: IdpOptions): Promise<IdpService> {
  const logger = options.logger ?? createLogger("manage-api:idp");
  const issuerUrl = new URL(options.issuer);
  const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
  // 令牌的受众：管理接口与网关这两个资源。标识在共享包里定义，验签的一方用同一个函数算出来核对。
  // 它们都在本地验签，所以令牌格式必须是 JWT；
  // 而这家库只在明确声明了资源服务器时才发 JWT，否则发的是不透明的引用令牌。
  const apiResource = apiResourceIdentifier(options.issuer);
  // 公钥文件在构造 Provider 之前读完；读不到或格式不对，进程直接起不来。
  const jwks = options.jwksFile
    ? (JSON.parse(await readFile(options.jwksFile, "utf8")) as Configuration["jwks"])
    : undefined;
  const configuration: Configuration = {
    ...(jwks ? { jwks } : {}),
    clients: options.clients.map(toOidcClientMetadata),
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...customScopes,
      CLIENT_CREDENTIALS_SCOPE,
    ],
    // 每个范围带出哪些声明。库内置的映射只有 openid 的 sub 那几项，连 profile 的标准声明都没有；
    // 没登记的声明在生成身份令牌和用户信息时会被直接去掉，发现文档的 claims_supported 里也不会有它。
    // 写一项就会与内置的默认项合并。这里只给出建了档的用户确实有的：显示名。
    claims: {
      profile: ["name"],
    },
    subjectTypes: ["public"],
    routes: {
      authorization: "/connect/authorize",
      token: "/connect/token",
      jwks: "/connect/jwks",
      userinfo: "/connect/userinfo",
      revocation: "/connect/revoke",
      introspection: "/connect/introspect",
      end_session: "/connect/logout",
      device_authorization: "/connect/device_auth",
      pushed_authorization_request: "/connect/par",
    },
    // 无法用跳转交代的错误由这里出页面。库默认的错误页会去加载外部字体，不能用。
    renderError: async (ctx, out) => {
      ctx.type = "html";
      ctx.set("Content-Security-Policy", PAGE_CSP);
      ctx.body = errorPage({
        code: out.error,
        description: out.error_description,
        homeUrl: `${issuerPath}/`,
      });
    },
    features: {
      clientCredentials: { enabled: true },
      rpInitiatedLogout: {
        logoutSource: async (ctx, form) => {
          ctx.set("Content-Security-Policy", PAGE_CSP);
          ctx.body = logoutConfirmationPage({ host: ctx.host, form });
        },
      },
      // 吊销端点在这一版库里默认是关的，只配它的路径不会生效。
      // 撤销设备等于撤销它的刷新令牌，靠的就是这个端点。
      revocation: { enabled: true },
      // 内置的开发态登录页必须关掉：登录页由客户身份系统提供，或由我们自己的交互路由接管。
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        // 本期所有令牌都是发给管控平面自己的（管理接口与网关），客户端不必自己带 resource 参数。
        defaultResource: () => apiResource,
        // 换令牌与续期时同样不必再带一次 resource，沿用授权时定下的那一个。
        // 这一项默认是关的：关着的时候，用户经授权码换到的是不透明的引用令牌，
        // 管理接口与网关都无法在本地验签（服务账号走的是另一条发令牌的路径，不受影响）。
        useGrantedResource: () => true,
        getResourceServerInfo: () => ({
          audience: apiResource,
          // 这个资源上允许的范围。令牌最终的范围是“客户端申请的”与“这里声明的”的交集。
          scope: [...customScopes, "openid", "profile", "email", "offline_access"].join(" "),
          accessTokenFormat: "jwt",
          accessTokenTTL: 15 * 60,
        }),
      },
    },
    // 交互步骤用库默认的两步：login、consent。两步都由我们自己的交互路由处理，
    // 其中 consent 不向用户展示页面，由程序自动完成，见 autoGrantConsent。
    interactions: {
      url: (_ctx, interaction) => `${issuerPath}${INTERACTION_PATH_PREFIX}${interaction.uid}`,
    },
    ttl: {
      AccessToken: 15 * 60,
      ClientCredentials: 15 * 60,
      AuthorizationCode: 60,
      // 客户端拿到授权码后立刻来换，身份令牌不需要活很久。
      IdToken: 5 * 60,
      RefreshToken: 14 * 24 * 60 * 60,
      Session: 14 * 24 * 60 * 60,
      Grant: 14 * 24 * 60 * 60,
      Interaction: 10 * 60,
    },
    findAccount: async (_ctx, accountId) => {
      const account = await options.findAccount(accountId);
      if (!account) {
        return undefined;
      }
      return {
        accountId: account.id,
        claims: () => ({ sub: account.id, name: account.displayName }),
      };
    },
    extraTokenClaims: async (_ctx, token) => {
      // client_credentials 换到的令牌没有 accountId，归属就是客户端本身。
      // 这种令牌的 sub 由库填成客户端标识，这里不改它，只补充归属用的自定义声明。
      const accountId = "accountId" in token ? token.accountId : undefined;
      if (accountId === undefined) {
        return {
          "zm:accountType": "service",
          "zm:displayName": `service:${token.clientId}`,
          "zm:orgId": options.orgId,
        };
      }
      const account = await options.findAccount(accountId);
      return {
        "zm:accountType": "user",
        "zm:displayName": account?.displayName ?? "",
        "zm:orgId": options.orgId,
      };
    },
  };

  const provider = new Provider(options.issuer, configuration);
  // 让库底下的 Web 框架从转发头里读协议与主机名。转发头的值由下面的 pinRequestAddress 写入。
  provider.proxy = true;
  const oidcCallback = provider.callback();
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));

  /**
   * 把请求的对外地址固定成颁发者。凡是把请求交给库处理的入口都要先过这一道。
   *
   * 库拼端点地址时（发现文档里的各个端点、登录交互结束后回到授权端点的跳转），用的是“这次请求
   * 自己的地址”，也就是框架从转发头里读出的协议与主机名。不去管的话，它取决于反向代理有没有
   * 把这两个头传对、调用方又发了什么，于是可能出现颁发者是一个地址、端点指向另一个地址，
   * TLS 终止在反向代理时还会全变成 http。
   * 对外地址是部署时的已知量，就是颁发者，所以直接写入颁发者的协议与主机名，覆盖请求里原有的值：
   * 端点永远与颁发者同源，反向代理不必传递任何头。
   *
   * 返回 false 表示请求已被拒绝。只接受以 / 开头的请求行：写成完整地址的写法会让框架
   * 原样采用其中的主机名，上面写的转发头就不起作用了。
   */
  function pinRequestAddress(req: IncomingMessage, res: ServerResponse): boolean {
    if (!req.url?.startsWith("/")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return false;
    }
    req.headers["x-forwarded-proto"] = issuerUrl.protocol.slice(0, -1);
    req.headers["x-forwarded-host"] = issuerUrl.host;
    // 客户端地址不从请求头里采信：开了 proxy 之后框架按 X-Forwarded-For 取它，而那是调用方可以随便写的。
    delete req.headers["x-forwarded-for"];
    return true;
  }

  const handleOidc: InterceptHandler = (req, res) =>
    pinRequestAddress(req, res) ? oidcCallback(req, res) : undefined;

  /** “同意”交互里，库会告诉我们调用方还缺哪些批准。 */
  interface ConsentDetails {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    /** 键是资源标识，值是该资源上还缺的范围。 */
    missingResourceScopes?: Record<string, string[]>;
    rar?: unknown;
  }

  /** 封存件不存在、被改过、过期，或者对不上当前这一次：一律按“登录状态已失效”处理，不向调用方区分原因。 */
  function rejectStaleLogin(res: ServerResponse): void {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("登录状态已失效，请重新登录。");
  }

  function readTransaction(req: IncomingMessage): AuthTransaction | undefined {
    return openAuthTransaction(readCookie(req.headers.cookie, TRANSACTION_COOKIE), {
      key: options.stateKey,
      maxAgeMs: TRANSACTION_MAX_AGE_MS,
    });
  }

  /** 交互路由的入口。`/interaction/{uid}` 由库决定当前该走哪一步；`/interaction/{uid}/finish` 是登录的收尾。 */
  async function handleInteraction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", options.issuer).pathname;
    const [uid, stage, ...extra] = path
      .slice(issuerPath.length + INTERACTION_PATH_PREFIX.length)
      .split("/");
    const rest = stage ?? "";
    if (uid && rest === "finish" && extra.length === 0) {
      await finishLogin(req, res, uid);
      return;
    }
    // 只认 /interaction/{uid} 与 /interaction/{uid}/finish 两种写法，其余都是 404。
    if (!uid || (rest !== "" && rest !== "finish") || extra.length > 0) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const interaction = await provider.interactionDetails(req, res);
    if (interaction.prompt.name === "login") {
      await startLogin(res, interaction.uid);
      return;
    }
    if (interaction.prompt.name === "consent") {
      await autoGrantConsent(req, res, interaction);
      return;
    }
    throw new Error(`unexpected interaction prompt: ${interaction.prompt.name}`);
  }

  /** 登录交互：把浏览器带到客户身份系统。 */
  async function startLogin(res: ServerResponse, interactionUid: string): Promise<void> {
    const adapter = options.adapters[0];
    if (!adapter) {
      throw new Error("no auth adapter configured");
    }
    // state 由管控平面生成，回调时从封存件里取回来核对；适配器只负责把它带给客户身份系统。
    const state = createLoginState();
    const redirectStart = await adapter.buildAuthorizationUrl({
      state,
      callbackUrl: `${options.issuer}${CALLBACK_PATH_PREFIX}${adapter.id}`,
    });
    res.setHeader(
      "Set-Cookie",
      buildSetCookie({
        name: TRANSACTION_COOKIE,
        value: sealAuthTransaction(
          {
            step: "redirect",
            interactionUid,
            adapterId: adapter.id,
            state,
            codeVerifier: redirectStart.codeVerifier,
          },
          { key: options.stateKey },
        ),
        maxAgeSeconds: TRANSACTION_MAX_AGE_MS / 1000,
        secure: options.secureCookies,
      }),
    );
    res.writeHead(302, { Location: redirectStart.url });
    res.end();
  }

  /**
   * “同意”交互由程序自动完成：管控平面的客户端都是自己注册的，不向用户展示同意页。
   * 库靠这一步把批准的范围写进授权记录，不做的话授权记录里一个范围都没有，
   * 授权端点只能拒绝（access_denied）。调用方申请了什么就批准什么。
   */
  async function autoGrantConsent(
    req: IncomingMessage,
    res: ServerResponse,
    interaction: Awaited<ReturnType<typeof provider.interactionDetails>>,
  ): Promise<void> {
    const accountId = interaction.session?.accountId;
    if (!accountId) {
      throw new Error("consent interaction without a logged-in account");
    }
    const details = (interaction.prompt.details ?? {}) as ConsentDetails;
    const existing = interaction.grantId
      ? await provider.Grant.find(interaction.grantId)
      : undefined;
    const grant =
      existing ?? new provider.Grant({ accountId, clientId: String(interaction.params.client_id) });
    if (details.missingOIDCScope?.length) {
      grant.addOIDCScope(details.missingOIDCScope);
    }
    if (details.missingOIDCClaims?.length) {
      grant.addOIDCClaims(details.missingOIDCClaims);
    }
    for (const [resource, scopes] of Object.entries(details.missingResourceScopes ?? {})) {
      if (scopes.length) {
        grant.addResourceScope(resource, scopes);
      }
    }
    // 字段名是库里约定的 grantId，不是旧文档里的 grant_id。
    await provider.interactionFinished(
      req,
      res,
      { consent: { grantId: await grant.save() } },
      {
        mergeWithLastSubmission: true,
      },
    );
  }

  /** 回调地址里带的错误码只用来写日志；写成固定提示，不把请求参数回显到页面上。 */
  const UPSTREAM_ERROR_CODE = /^[a-z_]{1,64}$/;

  /**
   * 客户身份系统的回调。它只回答“是谁”，不结束交互：结束交互必须在交互自己的路径下进行，
   * 见 finishLogin。所以这里确认完身份，就把浏览器带到收尾的路由。
   */
  async function handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    adapterId: string,
  ): Promise<void> {
    const txn = readTransaction(req);
    // 封存件不存在、被改过、过期，第一步不对，或者不是这一个适配器发起的。
    if (!txn || txn.step !== "redirect" || txn.adapterId !== adapterId) {
      rejectStaleLogin(res);
      return;
    }
    const adapter = adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`unknown auth adapter: ${adapterId}`);
    }

    const callbackUrl = new URL(req.url ?? "/", options.issuer);
    const upstreamError = callbackUrl.searchParams.get("error");
    if (upstreamError) {
      // 使用者在客户身份系统那边点了取消，或者那边拒绝了。
      const code = UPSTREAM_ERROR_CODE.test(upstreamError) ? upstreamError : "unrecognized";
      logger.warn(undefined, `upstream login failed: ${code}`);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("客户身份系统没有完成登录。请重新登录。");
      return;
    }

    const identity = await adapter.finishLogin({
      callbackUrl,
      state: txn.state,
      codeVerifier: txn.codeVerifier,
    });
    const account = await options.upsertUser({ adapterId, identity });

    // 换成第二步的封存件：此后只需要记住“哪一次交互、哪个人”。state 与校验串已经用掉了，不再留着。
    res.setHeader(
      "Set-Cookie",
      buildSetCookie({
        name: TRANSACTION_COOKIE,
        value: sealAuthTransaction(
          { step: "finish", interactionUid: txn.interactionUid, accountId: account.id },
          { key: options.stateKey },
        ),
        maxAgeSeconds: TRANSACTION_MAX_AGE_MS / 1000,
        secure: options.secureCookies,
      }),
    );
    res.writeHead(303, {
      Location: `${issuerPath}${INTERACTION_PATH_PREFIX}${encodeURIComponent(txn.interactionUid)}/finish`,
    });
    res.end();
  }

  /**
   * 登录的收尾。这个路由在交互自己的路径之下，不是随手放的。
   *
   * 库把交互会话的 Cookie 限定在 /interaction/{uid} 这条路径上，浏览器只把它发给这条路径之下的请求。
   * 客户身份系统的回调地址是固定登记的，不在那条路径下，所以那里拿不到它、不能结束交互。
   * 这里核对封存件说的确实是当前这一次交互，才把“登录的是谁”交给库。
   */
  async function finishLogin(
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
  ): Promise<void> {
    const txn = readTransaction(req);
    if (!txn || txn.step !== "finish" || txn.interactionUid !== uid) {
      rejectStaleLogin(res);
      return;
    }
    // 库的交互会话 Cookie 不在了（使用者清过 Cookie，或者它过期了）。能确认就不必让库抛错。
    if (!readCookie(req.headers.cookie, provider.cookieName("interaction"))) {
      rejectStaleLogin(res);
      return;
    }
    let interaction: Awaited<ReturnType<typeof provider.interactionDetails>>;
    try {
      interaction = await provider.interactionDetails(req, res);
    } catch (error) {
      // 对使用者来说这就是登录失效，不该是一个看不出该怎么办的 500。
      // 这个版本的库没有公开它的错误类，只能按名字认；名字变了的话结果只是退回到 500。
      if (error instanceof Error && error.name === "SessionNotFound") {
        rejectStaleLogin(res);
        return;
      }
      throw error;
    }
    if (interaction.uid !== uid) {
      throw new Error("interaction mismatch on finishing login");
    }
    // 收尾用的封存件是一次性的：用掉就作废，同一个地址重放会被上面拦下。
    res.setHeader(
      "Set-Cookie",
      buildSetCookie({
        name: TRANSACTION_COOKIE,
        value: "",
        maxAgeSeconds: 0,
        secure: options.secureCookies,
      }),
    );
    await provider.interactionFinished(
      req,
      res,
      {
        login: {
          accountId: txn.accountId,
          remember: true,
          amr: ["ext"],
          acr: "urn:zm:auth:external",
        },
      },
      { mergeWithLastSubmission: false },
    );
  }

  function wrap(
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): InterceptHandler {
    return (req, res) =>
      pinRequestAddress(req, res)
        ? handler(req, res).catch((error: unknown) => {
            logger.error(undefined, "idp route failed", error);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            }
            res.end("Internal Server Error");
          })
        : undefined;
  }

  return {
    intercept(pathname) {
      if (pathname === DISCOVERY_PATH || pathname.startsWith("/connect/")) {
        return handleOidc;
      }
      if (pathname.startsWith(INTERACTION_PATH_PREFIX)) {
        return wrap(handleInteraction);
      }
      const adapterId = pathname.startsWith(CALLBACK_PATH_PREFIX)
        ? pathname.slice(CALLBACK_PATH_PREFIX.length)
        : undefined;
      if (adapterId) {
        return wrap((req, res) => handleCallback(req, res, adapterId));
      }
      return undefined;
    },
  };
}
