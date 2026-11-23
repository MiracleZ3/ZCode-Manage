import type { Hono } from "hono";
import { createBaseApp, type AuthEnv } from "@zm/shared";
import { ZM_VERSION } from "./build-time.js";
import { createOpenApiDocument, type OpenApiDocument } from "./openapi.js";
import type { ManageServices } from "./services.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerUsageRoutes } from "./routes/usage.js";

export const SERVICE_NAME = "manage-api";

export interface CreateAppOptions {
  services: ManageServices;
  /** 不传则按配置现场生成。测试里可以注入固定内容。 */
  openApiDocument?: OpenApiDocument;
}

export function createApp(options: CreateAppOptions): Hono<AuthEnv> {
  const { services } = options;
  let document = options.openApiDocument;
  const app = createBaseApp<AuthEnv>({
    service: SERVICE_NAME,
    version: ZM_VERSION,
    logger: services.logger,
  });
  registerClientRoutes(app, services);
  registerUsageRoutes(app, services);
  app.get("/em/v1/openapi.json", (c) => {
    document ??= createOpenApiDocument(services.config);
    return c.json(document);
  });
  return app;
}
