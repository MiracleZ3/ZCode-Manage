import { formatLogPrefix, startHttpServer } from "@zm/shared";
import { SERVICE_NAME, createApp } from "./app.js";
import { composeManageApi } from "./composition.js";

const logScope = `${SERVICE_NAME}:entry`;

async function main(): Promise<void> {
  const { config, services, idp, entryLogger, close } = await composeManageApi();
  const app = createApp({ services });

  await startHttpServer({
    fetch: (request) => app.fetch(request),
    hostname: config.host,
    port: config.port,
    logger: entryLogger,
    intercept: idp.intercept,
    // 监听关闭之后才收连接池：在此之前到达的请求还要用数据库。
    onClosed: close,
  });
}

void main().catch((error: unknown) => {
  console.error(formatLogPrefix(logScope), "startup failed", error);
  process.exitCode = 1;
});
