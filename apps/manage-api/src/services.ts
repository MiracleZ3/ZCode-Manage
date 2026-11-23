import {
  createDevice,
  decodeUsageCursor,
  listDevicesForUser,
  listEnabledModels,
  listUsageEvents,
  type DeviceRow,
  type ModelWithEndpoint,
  type UsageCursor,
  type UsageEventRow,
} from "@zm/database";
import type { Database } from "@zm/database";
import type { AuthMiddleware, Logger } from "@zm/shared";
import type { ManageApiConfig } from "./config.js";

/** 调用方回传的游标解不开。属于请求错误，路由层转成 400。 */
export class UsageCursorError extends Error {
  constructor() {
    super("invalid usage cursor");
    this.name = "UsageCursorError";
  }
}

/**
 * 路由依赖的全部能力。生产实现连数据库；单元测试给出内存里的替身，
 * 所以路由逻辑可以不碰数据库就被验证。
 */
export interface ManageServices {
  config: ManageApiConfig;
  logger: Logger;
  auth: AuthMiddleware;
  listModels(): Promise<ModelWithEndpoint[]>;
  /** userId 取自令牌的 sub，由路由传入；这里不接受请求体里指定的用户。 */
  registerDevice(input: {
    userId: string;
    device: { name: string; platform: string; clientVersion: string };
  }): Promise<DeviceRow>;
  listDevices(userId: string): Promise<DeviceRow[]>;
  listUsage(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ rows: UsageEventRow[]; nextCursor: UsageCursor | null }>;
}

export function createManageServices(deps: {
  db: Database;
  config: ManageApiConfig;
  logger: Logger;
  auth: AuthMiddleware;
}): ManageServices {
  const { db, config, logger, auth } = deps;
  return {
    config,
    logger,
    auth,
    listModels: () => listEnabledModels(db),
    registerDevice: ({ userId, device }) => createDevice(db, { userId, ...device }),
    listDevices: (userId) => listDevicesForUser(db, userId),
    listUsage(query) {
      const cursor =
        query.cursor === undefined ? undefined : decodeUsageCursorOrThrow(query.cursor);
      return listUsageEvents(db, { limit: query.limit, cursor });
    },
  };
}

function decodeUsageCursorOrThrow(cursor: string): UsageCursor {
  try {
    return decodeUsageCursor(cursor);
  } catch {
    throw new UsageCursorError();
  }
}
