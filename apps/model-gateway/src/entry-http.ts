import { serve } from "@hono/node-server";
import { createLogger, formatLogPrefix } from "@zm/shared";
import { SERVICE_NAME, createApp } from "./app.js";
import { loadConfig } from "./config.js";

const logScope = `${SERVICE_NAME}:entry`;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(logScope, { minLevel: config.logLevel });
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    // 监听任意地址时打印 localhost，打印出来的地址才可以直接访问。
    const hostname = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
    logger.info(undefined, `listening on http://${hostname}:${port}`);
  });

  // 容器停止时编排先发 SIGTERM。等在途请求结束再退出，不中断正在进行的响应。
  const shutdown = (signal: string): void => {
    logger.info(undefined, `received ${signal}, shutting down`);
    server.close((error) => {
      if (error) {
        logger.error(undefined, "server close failed", error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void main().catch((error: unknown) => {
  console.error(formatLogPrefix(logScope), "startup failed", error);
  process.exitCode = 1;
});
