import { createLogger, formatLogPrefix, startHttpServer } from "@zm/shared";
import { SERVICE_NAME, createMockApp } from "./app.js";
import { loadConfig } from "./config.js";

const logScope = `${SERVICE_NAME}:entry`;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createMockApp({ config });
  await startHttpServer({
    fetch: (request) => app.fetch(request),
    hostname: config.host,
    port: config.port,
    logger: createLogger(logScope, { minLevel: config.logLevel }),
  });
}

void main().catch((error: unknown) => {
  console.error(formatLogPrefix(logScope), "startup failed", error);
  process.exitCode = 1;
});
