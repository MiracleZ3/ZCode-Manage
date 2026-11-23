import {
  applyMigrations,
  createDatabase,
  findUserById,
  seedModelCatalogIfEmpty,
  upsertUserByIdentity,
  type Database,
} from "@zm/database";
import {
  createAccessTokenVerifier,
  createAuthMiddleware,
  createLogger,
  type Logger,
} from "@zm/shared";
import { createAdaptersFromConfig } from "./auth/oidc-upstream-adapter.js";
import { ZM_MIGRATIONS_DIR } from "./build-time.js";
import { loadConfig, type ManageApiConfig } from "./config.js";
import { createIdp, type IdpService } from "./idp/create-idp.js";
import { createManageServices, type ManageServices } from "./services.js";

export interface ComposeOptions {
  env?: NodeJS.ProcessEnv;
  /** 传入已经准备好的数据库连接时，不再自己建连接池；调用方负责它是已迁移的状态。 */
  db?: Database;
  migrationsFolder?: string;
}

export interface Composition {
  config: ManageApiConfig;
  db: Database;
  services: ManageServices;
  idp: IdpService;
  entryLogger: Logger;
  /** 关闭自己建的那个连接池；没有建则什么都不做。 */
  close: () => Promise<void>;
}

/**
 * 装配：读配置、连数据库并应用迁移、连上游身份系统、建 OIDC Provider、建业务服务。
 * 入口只调用它，然后启动 HTTP 服务。顺序有讲究：连不上上游身份系统就不监听端口，
 * 否则起来的是一个不能登录的假服务。
 */
export async function composeManageApi(options: ComposeOptions = {}): Promise<Composition> {
  const config = loadConfig({ env: options.env });
  const loggerOptions = { minLevel: config.logLevel } as const;
  const entryLogger = createLogger("manage-api:entry", loggerOptions);
  const authLogger = createLogger("manage-api:auth", loggerOptions);

  const own = options.db ? undefined : createDatabase({ connectionString: config.databaseUrl });
  const db = options.db ?? own?.db;
  if (!db) {
    throw new Error("database is required");
  }
  await applyMigrations(db, { migrationsFolder: options.migrationsFolder ?? ZM_MIGRATIONS_DIR });
  await seedModelCatalogIfEmpty(db, toModelSeeds(config));

  const adapters = await createAdaptersFromConfig(config.authAdapters);
  const idp = await createIdp({
    issuer: config.publicBaseUrl,
    clients: config.oidcClients,
    orgId: config.orgId,
    adapters,
    stateKey: config.authStateKey,
    secureCookies: new URL(config.publicBaseUrl).protocol === "https:",
    jwksFile: config.oidcJwksFile,
    logger: createLogger("manage-api:idp", loggerOptions),
    findAccount: (accountId) => findUserById(db, accountId),
    upsertUser: ({ adapterId, identity }) =>
      upsertUserByIdentity(db, {
        adapterId,
        subject: identity.subject,
        displayName: identity.displayName,
        email: identity.email,
      }),
  });

  const auth = createAuthMiddleware({
    verify: createAccessTokenVerifier({ issuer: config.publicBaseUrl }),
    onRejected: ({ requestId, reason }) =>
      authLogger.warn(requestId, "access token rejected", { reason }),
  });

  return {
    config,
    db,
    idp,
    services: createManageServices({ db, config, logger: entryLogger, auth }),
    entryLogger,
    close: () => (own ? closePool(own.pool) : Promise.resolve()),
  };
}

function toModelSeeds(config: ManageApiConfig) {
  return config.seedModels.map((seed) => ({
    id: seed.id,
    displayName: seed.displayName,
    contextWindow: seed.contextWindow,
    upstreamModel: seed.upstreamModel,
    endpoint: {
      id: seed.endpointId,
      name: seed.endpointId,
      protocol: "openai-chat-completions",
      baseUrl: seed.baseUrl,
      // 这里只记变量名。密钥本身在进程环境变量里，数据库不存。
      apiKeyEnv: "ZM_UPSTREAM_API_KEY",
    },
  }));
}

function closePool(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  return pool.end().then(() => undefined);
}
