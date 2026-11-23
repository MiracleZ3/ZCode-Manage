import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { asc, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageEventSchema, type UsageEventPage } from "@zm/contracts";
import { devices, usageEvents, users } from "@zm/database";
import { startStack, stopStack, type StackHandles } from "./support/harness.js";
import {
  TEST_DATABASE,
  createCookieJar,
  createPkce,
  getWithCookies,
  parseLoginForm,
  postFormWithCookies,
  readDevStack,
  type CookieJar,
  type DevStack,
} from "./support/stack.js";

const DISCOVERY = "/.well-known/openid-configuration";

/**
 * 用 node:http 发一个 GET，用在没有它就只能照 fetch 的规矩来的地方：
 * 指定 Host 头、指定转发头，或者让请求行直接写成一个完整地址。
 */
function rawGet(
  port: number,
  target: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "localhost", port, path: target, method: "GET", headers },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * 针对运行中的开发栈的集成测试：PostgreSQL 与 Keycloak 都是真实服务。
 * 先 pnpm stack:up，再 pnpm test:integration。
 * 断言的依据是数据库里真实落下的行，以及 Keycloak 真实返回的登录页。
 * 用例之间有先后依赖：后面的用例要用到前面换到的令牌与产生的数据。
 */

describe("开发栈集成", () => {
  const stack: DevStack = readDevStack();
  let ctx: StackHandles;
  let serviceToken = "";
  let userToken = "";
  let userSub = "";
  let refreshToken = "";
  let userIdToken = "";
  // 登录用例的 Cookie 罐。后面的退出登录用例要带着同一份会话 Cookie，所以放在用例组的作用域里。
  const loginJar = createCookieJar();

  /** 用户令牌申请的范围。换到的令牌、刷新后的令牌，范围都必须与它一字不差。 */
  const USER_SCOPE = "openid profile offline_access model:invoke device:register usage:read";

  beforeAll(async () => {
    ctx = await startStack(stack);
  }, 90_000);

  afterAll(async () => {
    // 装配阶段就失败时 ctx 还不存在，这时没有东西需要清理。
    if (ctx) {
      await stopStack(ctx, stack);
    }
  });

  /** 按时间正序取出全部用量，便于逐条核对。 */
  const readUsage = () =>
    ctx.db.select().from(usageEvents).orderBy(asc(usageEvents.occurredAt), asc(usageEvents.id));

  /** 换令牌。不替调用方判断成败：有的用例就是来验证失败的。 */
  async function requestToken(
    params: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${ctx.issuer}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const bearer = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  /**
   * 断言这是一个重定向，并返回它指向的地址。
   * 302 是普通的跳转；303 是 OIDC 库对授权请求的写法。两种都算。
   */
  function expectRedirect(response: Response): string {
    const location = response.headers.get("location");
    // 不是重定向、或没有跳转地址时，把状态码和响应头带进失败信息，便于定位是哪一环出的问题。
    const details = JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
    expect([302, 303], details).toContain(response.status);
    expect(location, details).toBeTruthy();
    return String(location);
  }

  /**
   * 依次跟随管控平面自己发出的跳转，直到浏览器被带回客户端的回调地址。
   * 完整的链是：回调、恢复授权、同意交互、再次恢复授权；设得宽一点，失败时列出走过的每一跳。
   */
  async function followUntilClientCallback(url: string, jar: CookieJar): Promise<URL> {
    let current = url;
    const visited: string[] = [];
    for (let hop = 0; hop < 10; hop += 1) {
      if (current.startsWith(ctx.clientCallback)) {
        return new URL(current);
      }
      const response = await getWithCookies(current, jar);
      visited.push(
        `${new URL(current).pathname} -> ${response.status} ${expectRedirect(response)}`,
      );
      current = new URL(expectRedirect(response), current).toString();
    }
    throw new Error(
      `redirect chain did not reach the client callback; visited:\n${visited.join("\n")}`,
    );
  }

  it("测试库名与装配代码里写死的建库语句一致", () => {
    expect(TEST_DATABASE).toBe("zm_integration_test");
  });

  it("对外地址只认配置：伪造 Host、转发头或请求行，都改变不了它公布的端点", async () => {
    const port = Number(new URL(ctx.issuer).port);
    const endpoints = [
      "authorization_endpoint",
      "token_endpoint",
      "jwks_uri",
      "revocation_endpoint",
    ];

    const expectEndpointsFollowIssuer = (document: Record<string, unknown>) => {
      expect(document.issuer).toBe(ctx.issuer);
      for (const name of endpoints) {
        const value = document[name];
        expect(
          typeof value === "string" && value.startsWith(`${ctx.issuer}/`),
          `${name} = ${String(value)}`,
        ).toBe(true);
      }
    };

    // Host 指向别处：反向代理改写了它，或者调用方故意这么发。
    const forgedHost = await rawGet(port, DISCOVERY, { host: "evil.example:9" });
    expectEndpointsFollowIssuer(JSON.parse(forgedHost.body) as Record<string, unknown>);

    // 转发头指向别处。库默认按它们拼协议与主机名，TLS 终止在代理时还容易漏传前者。
    const forgedForwarding = await rawGet(port, DISCOVERY, {
      host: `localhost:${port}`,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    expectEndpointsFollowIssuer(JSON.parse(forgedForwarding.body) as Record<string, unknown>);

    // 请求行直接写成一个完整地址。这种写法会让库原样采用其中的主机名，所以一律拒绝。
    const absoluteForm = await rawGet(port, `http://evil.example${DISCOVERY}`, {
      host: "evil.example",
    });
    expect(absoluteForm.status).toBe(400);
  });

  it("服务账号：用 client_credentials 换到令牌；令牌能被公钥验签，归属声明符合规格", async () => {
    const issued = await requestToken({
      grant_type: "client_credentials",
      scope: "model:invoke",
      client_id: ctx.serviceClient.clientId,
      client_secret: ctx.serviceClient.clientSecret,
    });

    // 失败时把响应体带进断言信息，便于看到颁发者给出的具体错误。
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      scope: "model:invoke",
    });
    serviceToken = String(issued.body.access_token);

    const { payload } = await jwtVerify(
      serviceToken,
      createRemoteJWKSet(new URL(`${ctx.issuer}/connect/jwks`)),
      {
        issuer: ctx.issuer,
      },
    );
    expect(payload).toMatchObject({
      iss: ctx.issuer,
      // 令牌签给管控平面自己的 api 资源；管理接口与网关验签时核对的就是这个受众。
      aud: `${ctx.issuer}/api`,
      client_id: ctx.serviceClient.clientId,
      // 服务账号令牌的 sub 由颁发者填成客户端标识。
      sub: ctx.serviceClient.clientId,
      scope: "model:invoke",
      "zm:accountType": "service",
      "zm:orgId": "org-dev",
    });

    // 密钥不对的客户端被拒绝，错误码是标准的 invalid_client。
    const wrongSecret = await requestToken({
      grant_type: "client_credentials",
      scope: "model:invoke",
      client_id: ctx.serviceClient.clientId,
      client_secret: randomBytes(8).toString("hex"),
    });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.error).toBe("invalid_client");
  });

  it("服务账号令牌能读模型目录，但没有注册设备的范围", async () => {
    const models = await fetch(`${ctx.issuer}/em/v1/models`, { headers: bearer(serviceToken) });
    const body = (await models.json()) as { models: { id: string }[] };

    expect(models.status).toBe(200);
    expect(body.models.map((model) => model.id)).toEqual(["failing-dev", "glm-dev"]);

    const device = await fetch(`${ctx.issuer}/em/v1/devices`, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({
        name: "not allowed",
        platform: "darwin",
        clientVersion: "0.0.0-test",
      }),
    });
    expect(device.status).toBe(403);
  });

  it("经 Keycloak 登录：授权码加 PKCE 的完整跳转链走通，管控平面为用户建档", async () => {
    const jar = loginJar;
    const pkce = createPkce();
    const state = randomBytes(16).toString("base64url");
    const scope = USER_SCOPE;
    const authorize = new URL(`${ctx.issuer}/connect/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "it-ee-client",
      redirect_uri: ctx.clientCallback,
      scope,
      // 申请 offline_access 的授权请求必须带 prompt=consent，这是 OpenID Connect 的规定。
      // 不带的话颁发者按规范静默忽略这个范围：不报错，但换到的令牌里没有它，也不发刷新令牌。
      prompt: "consent",
      state,
      nonce: randomBytes(12).toString("hex"),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }).toString();

    // ① 客户端把浏览器带到管控平面的授权端点。管控平面发现还没登录，转到自己的登录交互路由。
    //    地址按当前请求地址补全：有的跳转给的是相对地址。
    const authorizeResponse = await getWithCookies(authorize.toString(), jar);
    const interactionUrl = new URL(expectRedirect(authorizeResponse), authorize);
    expect(
      interactionUrl.origin,
      JSON.stringify({ location: authorizeResponse.headers.get("location") }),
    ).toBe(ctx.issuer);
    expect(interactionUrl.pathname.startsWith("/interaction/")).toBe(true);

    // ② 登录交互把浏览器带到客户身份系统。state 由管控平面生成，封存在 Cookie 里。
    const idpAuthorizeUrl = expectRedirect(await getWithCookies(interactionUrl.toString(), jar));
    expect(idpAuthorizeUrl.startsWith(stack.keycloak.issuer)).toBe(true);

    // ③ 用户在 Keycloak 的登录页里输入账号与口令。
    const loginPage = await getWithCookies(idpAuthorizeUrl, jar);
    const loginHtml = await loginPage.text();
    // 失败时带上页面里的文字：Keycloak 会把拒绝原因直接写在页面上。先去掉脚本和样式，只留可读文字。
    const pageText = loginHtml
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
    expect(loginPage.status, pageText).toBe(200);
    const form = parseLoginForm(loginHtml);
    const callbackUrl = expectRedirect(
      await postFormWithCookies(
        form.action,
        { ...form.fields, username: stack.keycloak.username, password: stack.keycloak.password },
        jar,
      ),
    );

    // ④ 客户身份系统带着授权码回到管控平面的回调；管控平面建档并结束登录交互，
    //    最后把浏览器带回客户端的回调地址。callbackUrl 来自第 ③ 步的跳转。
    expect(callbackUrl.startsWith(`${ctx.issuer}/auth/callback/keycloak-dev?`)).toBe(true);
    const clientCallback = await followUntilClientCallback(callbackUrl, jar);
    const callbackParams = Object.fromEntries(clientCallback.searchParams);
    // 颁发者把失败原因写在回调地址的参数里；失败时把它们带进断言信息。
    expect(callbackParams.error, JSON.stringify(callbackParams)).toBeUndefined();
    expect(callbackParams.state).toBe(state);
    expect(callbackParams.code).toBeTruthy();

    // ⑤ 客户端用授权码和 PKCE 校验串换令牌。
    const exchanged = await requestToken({
      grant_type: "authorization_code",
      code: String(callbackParams.code),
      redirect_uri: ctx.clientCallback,
      client_id: "it-ee-client",
      code_verifier: pkce.verifier,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.scope).toBe(scope);
    userToken = String(exchanged.body.access_token);
    // 访问令牌只有 15 分钟，客户端靠刷新令牌续期，所以这里必须拿到刷新令牌。
    expect(typeof exchanged.body.refresh_token, JSON.stringify(exchanged.body)).toBe("string");
    refreshToken = String(exchanged.body.refresh_token);

    const { payload } = await jwtVerify(
      userToken,
      createRemoteJWKSet(new URL(`${ctx.issuer}/connect/jwks`)),
      {
        issuer: ctx.issuer,
      },
    );
    expect(payload).toMatchObject({
      iss: ctx.issuer,
      aud: `${ctx.issuer}/api`,
      client_id: "it-ee-client",
      "zm:accountType": "user",
      "zm:displayName": "Alice 开发者",
    });
    userSub = String(payload.sub);

    // 显示名在身份令牌里。库的规则是：访问令牌带有受众就不能用于用户信息端点，
    // 这时经 profile 范围获批的声明会放进身份令牌。控制台靠它标出登录的是谁。
    // 前提是颁发者登记了“profile 范围带出 name 声明”，没登记的话声明会被悄悄去掉。
    const idToken = await jwtVerify(
      String(exchanged.body.id_token),
      createRemoteJWKSet(new URL(`${ctx.issuer}/connect/jwks`)),
      { issuer: ctx.issuer },
    );
    expect(idToken.payload).toMatchObject({
      sub: userSub,
      name: "Alice 开发者",
      aud: "it-ee-client",
    });
    userIdToken = String(exchanged.body.id_token);

    // 用户信息端点确实不接受带受众的访问令牌，这是上面那条规则的前提。
    const userInfo = await fetch(`${ctx.issuer}/connect/userinfo`, { headers: bearer(userToken) });
    expect(userInfo.status).toBe(401);

    // 首次登录自动建档：适配器标识加 Keycloak 里的主体标识。
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userSub));
    expect(user).toMatchObject({
      adapterId: "keycloak-dev",
      displayName: "Alice 开发者",
      email: "alice@example.test",
    });

    // 同一个回调不能重放：登录状态在第一次回调时已经作废。
    const replay = await getWithCookies(callbackUrl, jar);
    expect(replay.status).toBe(400);
  });

  it("刷新令牌：访问令牌过期后不用重新登录，换到的仍是同一个用户的令牌", async () => {
    const refreshed = await requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "it-ee-client",
    });

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      scope: USER_SCOPE,
    });

    // 归属声明不变：用量仍然记在最初登录的那个人名下。
    const { payload } = await jwtVerify(
      String(refreshed.body.access_token),
      createRemoteJWKSet(new URL(`${ctx.issuer}/connect/jwks`)),
      { issuer: ctx.issuer },
    );
    expect(payload).toMatchObject({
      sub: userSub,
      aud: `${ctx.issuer}/api`,
      client_id: "it-ee-client",
      "zm:accountType": "user",
    });

    // 续期时不再下发新的刷新令牌的话，续期一次就到头了。
    expect(typeof refreshed.body.refresh_token, JSON.stringify(refreshed.body)).toBe("string");
    refreshToken = String(refreshed.body.refresh_token);
  });

  it("登录之后：用户的令牌可以注册设备，设备归属是令牌里的用户", async () => {
    const registered = await fetch(`${ctx.issuer}/em/v1/devices`, {
      method: "POST",
      headers: bearer(userToken),
      body: JSON.stringify({
        name: "集成测试设备",
        platform: "darwin",
        clientVersion: "0.0.0-test",
      }),
    });
    const body = (await registered.json()) as { deviceId: string };

    expect(registered.status).toBe(201);
    const [device] = await ctx.db.select().from(devices).where(eq(devices.id, body.deviceId));
    expect(device).toMatchObject({ userId: userSub, name: "集成测试设备", platform: "darwin" });

    const listed = await fetch(`${ctx.issuer}/em/v1/devices`, { headers: bearer(userToken) });
    expect(
      ((await listed.json()) as { devices: { name: string }[] }).devices.map((item) => item.name),
    ).toEqual(["集成测试设备"]);
  });

  it("网关，非流式：回复来自替身服务，token 数与上游一致", async () => {
    const response = await fetch(ctx.gatewayChatUrl, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({ model: "glm-dev", messages: [{ role: "user", content: "你好" }] }),
    });
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };

    expect(response.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe("这是本地替身服务的回复。你说：你好");
    expect(body.usage.total_tokens).toBe(6);

    const rows = await readUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectType: "service",
      // 服务账号令牌的 sub 是客户端标识，用量的归属与它保持一致。
      subjectId: ctx.serviceClient.clientId,
      clientId: ctx.serviceClient.clientId,
      model: "glm-dev",
      upstreamModel: "glm-dev",
      statusCode: 200,
      stream: 0,
      inputTokens: 1,
      outputTokens: 5,
      totalTokens: 6,
      usageSource: "upstream",
      errorKind: null,
    });
  });

  it("网关，流式：字节原样透传；带 usage 的流记精确值，不带的记为 missing", async () => {
    const streamed = await fetch(ctx.gatewayChatUrl, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({
        model: "glm-dev",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "流式" }],
      }),
    });
    const text = await streamed.text();
    await ctx.gatewayApp.idle();

    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(text).toContain('"usage":{"prompt_tokens":1,"completion_tokens":5,"total_tokens":6}');

    const plain = await fetch(ctx.gatewayChatUrl, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({
        model: "glm-dev",
        stream: true,
        messages: [{ role: "user", content: "流式" }],
      }),
    });
    await plain.text();
    await ctx.gatewayApp.idle();

    const rows = (await readUsage()).filter((row) => row.stream === 1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ stream: 1, totalTokens: 6, usageSource: "upstream" });
    expect(rows[1]).toMatchObject({
      stream: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageSource: "missing",
    });
  });

  it("网关，失败路径：该拦的拦在上游之前，上游失败的照实记录", async () => {
    const before = (await readUsage()).length;

    const noToken = await fetch(ctx.gatewayChatUrl, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);

    const unknownModel = await fetch(ctx.gatewayChatUrl, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({
        model: "not-in-catalog",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(unknownModel.status).toBe(404);
    expect(await unknownModel.json()).toMatchObject({ error: { code: "model_not_found" } });

    // 没有到达上游的请求不记用量。范围不足由单元测试覆盖：这里的服务账号令牌与用户令牌都带有 model:invoke。
    expect(await readUsage()).toHaveLength(before);

    // 上游失败：状态码与响应体照实透传，用量归为 upstream_error。
    const upstreamFailure = await fetch(ctx.gatewayChatUrl, {
      method: "POST",
      headers: bearer(serviceToken),
      body: JSON.stringify({ model: "failing-dev", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(upstreamFailure.status).toBe(500);
    expect(await upstreamFailure.json()).toMatchObject({ error: { type: "server_error" } });
    const latest = (await readUsage()).at(-1);
    expect(latest).toMatchObject({
      model: "failing-dev",
      upstreamModel: "fail-500",
      statusCode: 500,
      usageSource: "missing",
      errorKind: "upstream_error",
    });
  });

  it("用量明细接口：分页不重不漏、按时间倒序；范围不足的令牌看不到", async () => {
    const expected = [...(await readUsage())].reverse().map((row) => row.id);
    const collect: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await fetch(
        `${ctx.issuer}/em/v1/usage/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        {
          headers: bearer(userToken),
        },
      );
      const body = (await response.json()) as UsageEventPage;
      expect(response.status).toBe(200);
      for (const item of body.items) {
        expect(usageEventSchema.safeParse(item).success).toBe(true);
        collect.push(item.id);
      }
      if (!body.nextCursor) {
        break;
      }
      cursor = body.nextCursor;
    }

    expect(collect).toEqual(expected);

    const forbidden = await fetch(`${ctx.issuer}/em/v1/usage/events`, {
      headers: bearer(serviceToken),
    });
    expect(forbidden.status).toBe(403);
  });

  it("退出登录：结束会话后回到登记过的地址，之后再发起登录得重新登录", async () => {
    // 带着浏览器在登录时拿到的 Cookie 发起授权。prompt=none 的意思是别弹任何页面：
    // 有会话就直接带着授权码回来，没有会话就带着 login_required 回来。
    const probe = new URL(`${ctx.issuer}/connect/authorize`);
    probe.search = new URLSearchParams({
      response_type: "code",
      client_id: "it-ee-client",
      redirect_uri: ctx.clientCallback,
      scope: "openid",
      prompt: "none",
      state: randomBytes(8).toString("hex"),
      nonce: randomBytes(8).toString("hex"),
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const clientPage = (response: Response) => {
      const target = new URL(expectRedirect(response));
      // 目标必须是客户端自己的回调地址，参数里或者是授权码、或者是错误码。
      expect(`${target.origin}${target.pathname}`).toBe(ctx.clientCallback);
      return target;
    };

    // 退出之前：会话还在。
    const before = clientPage(await getWithCookies(probe.toString(), loginJar));
    expect(before.searchParams.get("code"), before.toString()).toBeTruthy();

    // 退出要两步。先到结束会话端点领一个确认页：防止第三方页面把人悄悄登出。
    const confirmPage = await getWithCookies(
      `${ctx.issuer}/connect/logout?${new URLSearchParams({
        id_token_hint: userIdToken,
        post_logout_redirect_uri: ctx.afterLogoutUrl,
      })}`,
      loginJar,
    );
    expect(confirmPage.status).toBe(200);
    const html = await confirmPage.text();
    const action = html.match(/\baction="([^"]+)"/)?.[1];
    const xsrf = html.match(/\bname="xsrf" value="([^"]+)"/)?.[1];
    expect(action, html.slice(0, 300)).toBeTruthy();
    expect(xsrf, html.slice(0, 300)).toBeTruthy();
    // 确认页不引用任何外部资源：交付环境是完全离线的。
    // 库给的表单 action 是指向颁发者自己的绝对地址，所以只排除颁发者之外的地址。
    for (const url of html.match(/https?:\/\/[^"\s]+/g) ?? []) {
      expect(url.startsWith(ctx.issuer), url).toBe(true);
    }
    expect(html).not.toMatch(/@import|<link\b|<script\b/i);

    // 再点“退出登录”：提交确认表单。带 logout 字段才表示确认。
    const confirmed = await postFormWithCookies(
      new URL(String(action), `${ctx.issuer}/`).toString(),
      { xsrf: String(xsrf), logout: "yes" },
      loginJar,
    );
    const location = new URL(expectRedirect(confirmed), `${ctx.issuer}/`);
    expect(location.href).toBe(ctx.afterLogoutUrl);
    expect(confirmPage.headers.get("content-security-policy")).toContain("default-src 'none'");

    // 退出之后：同一个浏览器再发起授权，被明确告知需要重新登录。
    const after = clientPage(await getWithCookies(probe.toString(), loginJar));
    expect(after.searchParams.get("error"), after.toString()).toBe("login_required");
  });

  // 放在最后：撤销刷新令牌会让这一整份授权作废，放在前面，后面用例手里的用户令牌就不可靠了。
  it("吊销：刷新令牌撤销后不能再续期；已签发的访问令牌到期前仍然可用", async () => {
    const revoke = await fetch(`${ctx.issuer}/connect/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // 公共客户端没有密钥，只凭客户端标识。RFC 7009 规定：无论令牌是否存在，都回 200。
      body: new URLSearchParams({ token: refreshToken, client_id: "it-ee-client" }).toString(),
    });
    expect(revoke.status, `${revoke.status} ${await revoke.clone().text()}`).toBe(200);

    const afterRevoke = await requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "it-ee-client",
    });
    expect(afterRevoke.status).toBe(400);
    expect(afterRevoke.body.error).toBe("invalid_grant");

    // 管理接口与网关在本地验签，颁发者撤销令牌后通知不到它们。
    // 这是规格第 11 节写明的取舍：吊销只保证不能再续期，访问令牌到自然过期前仍然有效。
    const stillValid = await fetch(`${ctx.issuer}/em/v1/devices`, { headers: bearer(userToken) });
    expect(stillValid.status).toBe(200);
  });
});
