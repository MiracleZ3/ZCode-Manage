import type { Hono } from "hono";
import { createBaseApp, type ServiceAppEnv } from "@zm/shared";
import { ZM_VERSION } from "./version.js";

export const SERVICE_NAME = "manage-api";

/** Step 0 只验证骨架：配置、启动、健康检查与统一错误出口。业务路由在 Step 1 加入。 */
export function createApp(): Hono<ServiceAppEnv> {
  return createBaseApp({ service: SERVICE_NAME, version: ZM_VERSION });
}
