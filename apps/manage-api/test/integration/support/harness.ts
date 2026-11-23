import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { applyMigrations, createDatabase, type Database } from "@zm/database";
import {
  createAccessTokenVerifier,
  createAuthMiddleware,
  createLogger,
  listenForTest,
  startHttpServer,
  type HttpServerHandle,
  type Logger,
} from "@zm/shared";
import { createApp } from "../../../src/app.js";
import { composeManageApi } from "../../../src/composition.js";
import { createGatewayApp, type GatewayApp } from "../../../../model-gateway/src/app.js";
import { createGatewayServices } from "../../../../model-gateway/src/services.js";
import { createMockApp } from "../../../../mock-model/src/app.js";
import { REPO_ROOT, TEST_DATABASE, getFreePort, type DevStack } from "./stack.js";

export interface StackHandles {
  db: Database;
  pool: pg.Pool;
  /** 管控平面的颁发者地址，也是访问管理接口的基址。 */
  issuer: string;
  api: HttpServerHandle;
  gatewayApp: GatewayApp;
  gateway: HttpServerHandle;
  /** 网关的 Chat Completions 地址。 */
  gatewayChatUrl: string;
  mock: HttpServerHandle;
  serviceClient: { clientId: string; clientSecret: string };
  /** 企业版客户端的回调地址，只登记在客户端元数据里。 */
  clientCallback: string;
  /** 退出登录之后把浏览器带回的地址，同样只登记在客户端元数据里。 */
  afterLogoutUrl: string;
}

function createTestLogger(scope: string): Logger {
  const noop = () => {};
  return createLogger(scope, {
    sink: { log: noop, warn: noop, error: noop, debug: noop },
    minLevel: "error",
  });
}

/** 以数据库超级用户的身份连到 postgres 库执行管理语句；库名 zm_integration_test 写死在每条语句里。 */
async function withAdminPool<T>(
  databaseUrl: string,
  action: (admin: pg.Pool) => Promise<T>,
): Promise<T> {
  const admin = new pg.Pool({ connectionString: `${databaseUrl}/postgres` });
  try {
    return await action(admin);
  } finally {
    await admin.end();
  }
}

/** 确认开发栈的数据库连得上，连不上时报出该怎么处理。 */
async function assertDatabaseReachable(databaseUrl: string): Promise<void> {
  try {
    await withAdminPool(databaseUrl, (admin) => admin.query("SELECT 1"));
  } catch (error) {
    throw new Error("连不上开发栈的 PostgreSQL：先执行 pnpm stack:up", { cause: error });
  }
}

/** 测试库每次运行都重建，所以先删后建；这不影响开发库里的数据。 */
async function recreateTestDatabase(databaseUrl: string): Promise<void> {
  await withAdminPool(databaseUrl, async (admin) => {
    await admin.query("DROP DATABASE IF EXISTS zm_integration_test WITH (FORCE)");
    await admin.query("CREATE DATABASE zm_integration_test");
  });
}

async function dropTestDatabase(databaseUrl: string): Promise<void> {
  await withAdminPool(databaseUrl, (admin) =>
    admin.query("DROP DATABASE IF EXISTS zm_integration_test WITH (FORCE)"),
  );
}

/**
 * 关服务、断连接、删测试库。每一步即使前一步失败也要执行，所以逐个收集异常，最后一起抛。
 * 装配中途失败时也用它收回已经建好的部分，所以每个字段都允许还不存在。
 */
async function release(
  started: { pool?: pg.Pool; gatewayApp?: GatewayApp; servers: HttpServerHandle[] },
  stack: DevStack,
): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(new Error(`${label}失败`, { cause: error }));
    }
  };
  if (started.gatewayApp) {
    const gatewayApp = started.gatewayApp;
    await attempt("等待用量落库", () => Promise.resolve(gatewayApp.idle()));
  }
  await Promise.all(started.servers.map((server) => attempt("关闭服务", () => server.close())));
  if (started.pool) {
    const pool = started.pool;
    await attempt("关闭数据库连接", () => Promise.resolve(pool.end()));
    // 连接全部断开之后才能删库。
    await attempt("删除测试库", () => dropTestDatabase(stack.databaseUrl));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "清理集成测试环境时出错");
  }
}

/**
 * 把整套服务在测试进程里起起来：替身模型服务、网关、管理端，
 * 共用一个测试数据库，并且都真实地连接开发栈里的 PostgreSQL 与 Keycloak。
 */
export async function startStack(stack: DevStack): Promise<StackHandles> {
  const logger = createTestLogger("integration");
  // 已经建好的资源都登记在这里；中途失败时按登记的收回。
  const started: { pool?: pg.Pool; gatewayApp?: GatewayApp; servers: HttpServerHandle[] } = {
    servers: [],
  };

  try {
    await assertDatabaseReachable(stack.databaseUrl);
    await recreateTestDatabase(stack.databaseUrl);

    const databaseUrl = `${stack.databaseUrl}/${TEST_DATABASE}`;
    const { db, pool } = createDatabase({ connectionString: databaseUrl });
    started.pool = pool;
    await applyMigrations(db, {
      migrationsFolder: resolve(REPO_ROOT, "packages/database/migrations"),
    });

    // 上游密钥运行时随机生成：网关从环境变量读它，替身服务校验它。
    const upstreamApiKey = randomBytes(16).toString("hex");
    const mockApp = createMockApp({ config: { apiKey: upstreamApiKey, streamChunkDelayMs: 0 } });
    const mock = await listenForTest({ fetch: (request) => mockApp.fetch(request), logger });
    started.servers.push(mock);

    // 管理端的端口要事先定下来：颁发者地址会写进令牌，也会出现在 Keycloak 的回调跳转里。
    const apiPort = await getFreePort();
    const issuer = `http://localhost:${apiPort}`;

    const gatewayApp = createGatewayApp(
      createGatewayServices({
        db,
        config: { host: "127.0.0.1", port: 0, issuer, databaseUrl, upstreamTimeoutMs: 5_000 },
        logger,
        auth: createAuthMiddleware({ verify: createAccessTokenVerifier({ issuer }) }),
        env: { ZM_UPSTREAM_API_KEY: upstreamApiKey },
      }),
    );
    started.gatewayApp = gatewayApp;
    const gateway = await listenForTest({
      fetch: (request) => gatewayApp.app.fetch(request),
      logger,
    });
    started.servers.push(gateway);

    const serviceClient = { clientId: "it-service", clientSecret: randomBytes(16).toString("hex") };
    const clientCallback = `http://127.0.0.1:${await getFreePort()}/callback`;
    const afterLogoutUrl = `http://127.0.0.1:${await getFreePort()}/signed-out`;
    const mockBaseUrl = `http://127.0.0.1:${mock.port}/v1`;
    const composition = await composeManageApi({
      env: {
        ZM_PUBLIC_BASE_URL: issuer,
        ZM_DATABASE_URL: databaseUrl,
        ZM_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}`,
        ZM_PORT: String(apiPort),
        ZM_AUTH_STATE_KEY: randomBytes(32).toString("hex"),
        ZM_OIDC_CLIENTS_JSON: JSON.stringify([
          // 服务账号客户端：脚本、CI，以及下面的服务账号测试。
          {
            clientId: serviceClient.clientId,
            clientSecret: serviceClient.clientSecret,
            redirectUris: [],
            grantTypes: ["client_credentials"],
            scope: "model:invoke",
            tokenEndpointAuthMethod: "client_secret_post",
          },
          // 公共客户端：模拟企业版客户端，走授权码加 PKCE。
          {
            clientId: "it-ee-client",
            redirectUris: [clientCallback],
            postLogoutRedirectUris: [afterLogoutUrl],
            grantTypes: ["authorization_code", "refresh_token"],
            scope: "openid profile offline_access model:invoke device:register usage:read",
            tokenEndpointAuthMethod: "none",
          },
        ]),
        ZM_AUTH_ADAPTERS_JSON: JSON.stringify([
          {
            id: "keycloak-dev",
            kind: "oidc-upstream",
            issuer: stack.keycloak.issuer,
            clientId: stack.keycloak.clientId,
            clientSecret: stack.keycloak.clientSecret,
            // 开发栈里的 Keycloak 是明文 HTTP，只对本机回环地址开放。
            allowInsecureHttp: true,
          },
        ]),
        ZM_SEED_MODELS_JSON: JSON.stringify([
          {
            id: "glm-dev",
            displayName: "IT 模型",
            contextWindow: 128000,
            endpointId: "mock-openai",
            baseUrl: mockBaseUrl,
            upstreamModel: "glm-dev",
          },
          {
            // 上游模型名与目录里的名字不同，用来验证网关会改写请求体里的 model。
            id: "failing-dev",
            displayName: "IT 故意失败的模型",
            contextWindow: 128000,
            endpointId: "mock-openai",
            baseUrl: mockBaseUrl,
            upstreamModel: "fail-500",
          },
        ]),
      },
      db,
      migrationsFolder: resolve(REPO_ROOT, "packages/database/migrations"),
    });
    const apiHono = createApp({ services: composition.services });
    // 监听 localhost 而不是 127.0.0.1：颁发者地址里写的是 localhost。
    const api = await startHttpServer({
      fetch: (request) => apiHono.fetch(request),
      hostname: "localhost",
      port: apiPort,
      logger,
      intercept: composition.idp.intercept,
      handleSignals: false,
    });
    started.servers.push(api);

    return {
      db,
      pool,
      issuer,
      api,
      gatewayApp,
      gateway,
      gatewayChatUrl: `http://127.0.0.1:${gateway.port}/gateway/v1/chat/completions`,
      mock,
      serviceClient,
      clientCallback,
      afterLogoutUrl,
    };
  } catch (error) {
    await release(started, stack).catch(() => {});
    throw error;
  }
}

/** 一组测试结束后，关掉全部服务并删除测试库。 */
export function stopStack(handles: StackHandles, stack: DevStack): Promise<void> {
  return release(
    {
      pool: handles.pool,
      gatewayApp: handles.gatewayApp,
      servers: [handles.api, handles.gateway, handles.mock],
    },
    stack,
  );
}
