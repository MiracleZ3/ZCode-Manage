import { describe, expect, it } from "vitest";
import type { AccessTokenClaims, Device, Model, UsageEvent } from "@zm/contracts";
import {
  encodeUsageCursor,
  type DeviceRow,
  type ModelEndpointRow,
  type ModelRow,
  type UsageCursor,
  type UsageEventRow,
} from "@zm/database";
import {
  createAuthMiddleware,
  createLogger,
  type LoggerSink,
  type TokenVerification,
} from "@zm/shared";
import { createApp } from "../src/app.js";
import type { ManageApiConfig } from "../src/config.js";
import { ENDPOINTS, createOpenApiDocument } from "../src/openapi.js";
import { UsageCursorError, type ManageServices } from "../src/services.js";

const ISSUER = "http://manage.test";

/** 三种令牌：能注册设备的普通用户、只带用量只读范围的账号、没有自定义范围的服务账号。 */
const USER: AccessTokenClaims = {
  sub: "0f0e6d5a-0000-4000-8000-000000000001",
  client_id: "zcode-ee-dev",
  scope: "openid model:invoke device:register",
  "zm:accountType": "user",
  "zm:displayName": "Alice",
  "zm:orgId": "org-dev",
};

const VIEWER: AccessTokenClaims = {
  sub: "0f0e6d5a-0000-4000-8000-000000000002",
  client_id: "zm-console-dev",
  scope: "openid usage:read",
  "zm:accountType": "user",
  "zm:displayName": "Bob",
  "zm:orgId": "org-dev",
};

const NARROW: AccessTokenClaims = {
  sub: "service:narrow",
  client_id: "svc-narrow",
  scope: "model:invoke",
  "zm:accountType": "service",
  "zm:displayName": "service:narrow",
  "zm:orgId": "org-dev",
};

const CLAIMS_BY_TOKEN: Record<string, AccessTokenClaims> = {
  user: USER,
  viewer: VIEWER,
  narrow: NARROW,
};
type TestToken = keyof typeof CLAIMS_BY_TOKEN;

const verify = async (token: string): Promise<TokenVerification> => {
  const claims = CLAIMS_BY_TOKEN[token];
  return claims ? { ok: true, claims } : { ok: false, reason: "signature" };
};

const bearer = (token: TestToken) => ({ authorization: `Bearer ${token}` });

function createSilentSink(): LoggerSink {
  const noop = () => {};
  return { log: noop, warn: noop, error: noop, debug: noop };
}

const ENDPOINT: ModelEndpointRow = {
  id: "mock-openai",
  name: "mock-openai",
  protocol: "openai-chat-completions",
  baseUrl: "http://127.0.0.1:8082/v1",
  apiKeyEnv: "ZM_UPSTREAM_API_KEY",
};

const MODEL: ModelRow = {
  id: "glm-dev",
  endpointId: ENDPOINT.id,
  upstreamModel: "glm-dev",
  displayName: "GLM（本地替身）",
  contextWindow: 128000,
  enabled: 1,
};

/** 设备编号在契约里是 UUID，夹具也照此生成。 */
function nextDeviceId(index: number): string {
  return `0f0e6d5a-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const USAGE_ROWS: UsageEventRow[] = ["c1", "c2"].map((suffix, index) => ({
  id: `0f0e6d5a-0000-4000-8000-0000000000${suffix}`,
  requestId: `req-${index}`,
  occurredAt: new Date(Date.UTC(2026, 10, 23, 10, index)),
  subjectType: "service",
  subjectId: "service:svc",
  subjectName: "service:svc",
  clientId: "svc",
  model: MODEL.id,
  upstreamModel: MODEL.upstreamModel,
  endpointId: ENDPOINT.id,
  inputTokens: 3,
  outputTokens: 2,
  totalTokens: 5,
  statusCode: 200,
  stream: 0,
  durationMs: 20,
  usageSource: "upstream",
  errorKind: null,
}));

/** 内存里的替身服务：只实现路由会碰到的行为，不连数据库。 */
function createServices(overrides: Partial<ManageServices> = {}): ManageServices {
  const devices: DeviceRow[] = [];
  const config = {
    publicBaseUrl: ISSUER,
    gatewayBaseUrl: "http://gateway.test",
    minimalClientVersion: "0.0.1",
    heartbeatIntervalSeconds: 60,
  } as ManageApiConfig;
  const base: ManageServices = {
    config,
    logger: createLogger("test", { sink: createSilentSink(), minLevel: "error" }),
    auth: createAuthMiddleware({ verify }),
    listModels: async () => [{ model: MODEL, endpoint: ENDPOINT }],
    registerDevice: async ({ userId, device }) => {
      const row: DeviceRow = {
        id: nextDeviceId(devices.length + 1),
        userId,
        ...device,
        createdAt: new Date("2026-11-23T10:00:00.000Z"),
      };
      devices.push(row);
      return row;
    },
    listDevices: async (userId) => devices.filter((device) => device.userId === userId),
    // 每次都交出全部用量；分页本身属于仓储层，在集成测试里验证。
    listUsage: async ({ limit }) => ({ rows: USAGE_ROWS.slice(0, limit), nextCursor: null }),
  };
  return { ...base, ...overrides };
}

const registerBody = JSON.stringify({
  name: "我的电脑",
  platform: "darwin",
  clientVersion: "1.0.0",
});

const registerDevice = (services: ManageServices, token: TestToken, body: unknown = registerBody) =>
  createApp({ services }).request("/em/v1/devices", {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("公开接口", () => {
  it("引导配置由颁发者地址派生出各个入口", async () => {
    const response = await createApp({ services: createServices() }).request("/em/v1/bootstrap");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/connect/authorize`,
      tokenEndpoint: `${ISSUER}/connect/token`,
      jwksUri: `${ISSUER}/connect/jwks`,
      gatewayBaseUrl: "http://gateway.test",
      minimalClientVersion: "0.0.1",
      heartbeatIntervalSeconds: 60,
    });
  });
});

describe("需要令牌的接口", () => {
  it("没有令牌一律 401，不会落到“没有数据”的 200", async () => {
    const app = createApp({ services: createServices() });

    for (const path of ["/em/v1/models", "/em/v1/devices", "/em/v1/usage/events"]) {
      expect((await app.request(path)).status, path).toBe(401);
    }
  });

  it("模型目录只暴露契约里的字段，不暴露上游模型名与端点地址", async () => {
    const response = await createApp({ services: createServices() }).request("/em/v1/models", {
      headers: bearer("narrow"),
    });
    const body = (await response.json()) as { models: Model[] };

    expect(response.status).toBe(200);
    expect(body.models).toEqual([
      {
        id: "glm-dev",
        displayName: "GLM（本地替身）",
        contextWindow: 128000,
        endpointId: "mock-openai",
      },
    ]);
  });
});

describe("设备", () => {
  it("注册成功返回 201；归属取自令牌里的 sub", async () => {
    let registeredFor = "";
    const services = createServices({
      registerDevice: async ({ userId, device }) => {
        registeredFor = userId;
        return {
          id: nextDeviceId(10),
          userId,
          ...device,
          createdAt: new Date("2026-11-23T10:00:00.000Z"),
        };
      },
    });

    const response = await registerDevice(services, "user");
    const device = (await response.json()) as Device;

    expect(response.status).toBe(201);
    expect(registeredFor).toBe(USER.sub);
    expect(device).toEqual({
      deviceId: nextDeviceId(10),
      name: "我的电脑",
      platform: "darwin",
      clientVersion: "1.0.0",
      createdAt: "2026-11-23T10:00:00.000Z",
    });
  });

  it("请求体里试图指定用户：契约不认识这个字段，直接 400，不会建档", async () => {
    let registered = 0;
    const services = createServices({
      registerDevice: async ({ userId, device }) => {
        registered += 1;
        return { id: nextDeviceId(1), userId, ...device, createdAt: new Date() };
      },
    });

    const response = await registerDevice(services, "user", {
      name: "n",
      platform: "darwin",
      clientVersion: "1",
      userId: "x",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    expect(registered).toBe(0);
  });

  it("令牌缺 device:register 范围：403，且不会建档", async () => {
    let registered = 0;
    const services = createServices({
      registerDevice: async ({ userId, device }) => {
        registered += 1;
        return { id: nextDeviceId(1), userId, ...device, createdAt: new Date() };
      },
    });

    const response = await registerDevice(services, "viewer");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect(registered).toBe(0);
  });

  it("设备列表只返回当前用户名下的设备，不返回别人的", async () => {
    const services = createServices();
    await services.registerDevice({
      userId: USER.sub,
      device: { name: "a", platform: "darwin", clientVersion: "1" },
    });
    await services.registerDevice({
      userId: "someone-else",
      device: { name: "b", platform: "win32", clientVersion: "1" },
    });

    const response = await createApp({ services }).request("/em/v1/devices", {
      headers: bearer("user"),
    });

    expect(
      ((await response.json()) as { devices: Device[] }).devices.map((device) => device.name),
    ).toEqual(["a"]);
  });
});

describe("用量明细", () => {
  it("按契约输出；游标是不透明的字符串，没有下一页时为 null", async () => {
    const passed: unknown[] = [];
    const services = createServices({
      listUsage: async (query) => {
        passed.push(query);
        return { rows: USAGE_ROWS, nextCursor: null };
      },
    });

    const response = await createApp({ services }).request("/em/v1/usage/events?limit=50", {
      headers: bearer("viewer"),
    });
    const page = (await response.json()) as { items: UsageEvent[]; nextCursor: string | null };

    expect(response.status).toBe(200);
    expect(passed).toEqual([{ limit: 50, cursor: undefined }]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      id: USAGE_ROWS[0]?.id,
      occurredAt: "2026-11-23T10:00:00.000Z",
      statusCode: 200,
      stream: false,
      usageSource: "upstream",
      errorKind: null,
    });
  });

  it("有下一页时把游标编码后返回；limit 超出上限是 400", async () => {
    const first = USAGE_ROWS[0];
    if (!first) {
      throw new Error("fixture has no usage rows");
    }
    const nextCursor: UsageCursor = { occurredAt: first.occurredAt, id: first.id };
    const app = createApp({
      services: createServices({ listUsage: async () => ({ rows: USAGE_ROWS, nextCursor }) }),
    });
    const page = (await (
      await app.request("/em/v1/usage/events", { headers: bearer("viewer") })
    ).json()) as {
      nextCursor: string;
    };

    expect(page.nextCursor).toBe(encodeUsageCursor(nextCursor));
    expect(
      (await app.request("/em/v1/usage/events?limit=501", { headers: bearer("viewer") })).status,
    ).toBe(400);
  });

  it("游标解不开是 400 的参数错误，不是 500", async () => {
    const services = createServices({
      listUsage: async (query) => {
        if (query.cursor !== undefined) {
          throw new UsageCursorError();
        }
        return { rows: USAGE_ROWS, nextCursor: null };
      },
    });
    const response = await createApp({ services }).request(
      "/em/v1/usage/events?cursor=bm90LWEtY3Vyc29y",
      {
        headers: bearer("viewer"),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error", requestId: expect.any(String) },
    });
  });

  it("缺 usage:read 范围的令牌看不到用量", async () => {
    const response = await createApp({ services: createServices() }).request(
      "/em/v1/usage/events",
      {
        headers: bearer("user"),
      },
    );

    expect(response.status).toBe(403);
  });
});

describe("接口说明与实际路由一致", () => {
  it("清单里的每一条都对应应用里已注册的路由，方法与路径不差", async () => {
    const app = createApp({ services: createServices() });
    const registered = new Set(
      app.routes
        .filter((route) => route.path !== "/*")
        .map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    const documented = new Set(
      ENDPOINTS.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`),
    );

    // 接口说明文件自身也是一个端点，不在清单里。
    documented.add("GET /em/v1/openapi.json");
    expect(registered).toEqual(documented);
  });

  it("由 zod 生成的 OpenAPI 文档写明了鉴权方式与每条接口的响应", async () => {
    const response = await createApp({ services: createServices() }).request("/em/v1/openapi.json");
    const document = (await response.json()) as {
      openapi: string;
      components: { securitySchemes: Record<string, { scheme: string }> };
      paths: Record<
        string,
        Record<string, { security?: unknown; responses: Record<string, unknown> }>
      >;
    };
    const post = document.paths["/em/v1/devices"]?.post;

    expect(document.openapi).toBe("3.1.0");
    expect(document.components.securitySchemes.bearerAuth?.scheme).toBe("bearer");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/healthz",
        "/em/v1/bootstrap",
        "/em/v1/models",
        "/em/v1/devices",
        "/em/v1/usage/events",
      ]),
    );
    expect(post?.security).toEqual([{ bearerAuth: ["device:register"] }]);
    expect(document.paths["/em/v1/models"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/em/v1/bootstrap"]?.get?.security).toBeUndefined();
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(["201", "400", "401", "403"]);
    // 响应体的结构来自契约：设备编号是 UUID 格式的字符串。
    // 响应体的结构来自契约：设备编号是 UUID 格式的字符串。
    const jsonResponse = post?.responses["201"] as {
      content: {
        "application/json": { schema: { properties: Record<string, Record<string, unknown>> } };
      };
    };

    expect(jsonResponse.content["application/json"].schema.properties.deviceId).toMatchObject({
      type: "string",
    });
  });

  it("不经过应用也能直接生成同样的文档", () => {
    expect(JSON.stringify(createOpenApiDocument({ publicBaseUrl: ISSUER }))).toContain(
      '"openapi":"3.1.0"',
    );
  });
});
