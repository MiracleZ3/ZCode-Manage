import {
  findEnabledModel,
  insertUsageEvent,
  listEnabledModels,
  type ModelWithEndpoint,
  type UsageEventInput,
} from "@zm/database";
import type { Database } from "@zm/database";
import type { AuthMiddleware, Logger } from "@zm/shared";
import type { GatewayConfig } from "./config.js";

export interface GatewayServices {
  config: GatewayConfig;
  logger: Logger;
  auth: AuthMiddleware;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  findModel(modelId: string): Promise<ModelWithEndpoint | undefined>;
  listModels(): Promise<ModelWithEndpoint[]>;
  /** 写入一条用量。request_id 重复时不重复写。 */
  recordUsage(event: UsageEventInput): Promise<boolean>;
}

/**
 * 生产实现只读模型目录、只写用量明细；目录的写入方是 manage-api。
 * 迁移也由 manage-api 负责，网关启动时不改数据库结构。
 */
export function createGatewayServices(deps: {
  db: Database;
  config: GatewayConfig;
  logger: Logger;
  auth: AuthMiddleware;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): GatewayServices {
  const { db } = deps;
  return {
    config: deps.config,
    logger: deps.logger,
    auth: deps.auth,
    env: deps.env ?? process.env,
    fetchFn: deps.fetchFn,
    findModel: (modelId) => findEnabledModel(db, modelId),
    listModels: () => listEnabledModels(db),
    recordUsage: (event) => insertUsageEvent(db, event),
  };
}
