import { createDatabase } from "@zm/database";
import {
  createAccessTokenVerifier,
  createAuthMiddleware,
  createLogger,
  formatLogPrefix,
  startHttpServer,
} from "@zm/shared";
import { SERVICE_NAME, createGatewayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createGatewayServices } from "./services.js";

const logScope = `${SERVICE_NAME}:entry`;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(logScope, { minLevel: config.logLevel });
  const { db, pool } = createDatabase({ connectionString: config.databaseUrl });

  const gateway = createGatewayApp(
    createGatewayServices({
      db,
      config,
      logger,
      auth: createAuthMiddleware({
        verify: createAccessTokenVerifier({ issuer: config.issuer }),
        onRejected: ({ requestId, reason }) =>
          logger.warn(requestId, "access token rejected", { reason }),
      }),
    }),
  );

  await startHttpServer({
    fetch: (request) => gateway.app.fetch(request),
    hostname: config.host,
    port: config.port,
    logger,
    onClosed: async () => {
      // 先等流式请求都结束、用量都写完，再断开数据库连接。
      await gateway.idle();
      await pool.end();
    },
  });
}

void main().catch((error: unknown) => {
  console.error(formatLogPrefix(logScope), "startup failed", error);
  process.exitCode = 1;
});
