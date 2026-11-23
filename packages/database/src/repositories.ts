import { and, desc, eq, sql } from "drizzle-orm";
import type { UsageErrorKind } from "@zm/contracts";
import type { Database } from "./client.js";
import {
  modelEndpoints,
  models,
  usageEvents,
  users,
  devices,
  type DeviceRow,
  type ModelEndpointRow,
  type ModelRow,
  type NewUsageEvent,
  type UsageEventRow,
  type UserRow,
} from "./schema.js";

/* ---------- 用户 ---------- */

export interface UserIdentity {
  adapterId: string;
  subject: string;
  displayName: string;
  email?: string;
}

/** 首次登录自动建档；以后登录只更新显示名和邮箱。 */
export async function upsertUserByIdentity(db: Database, identity: UserIdentity): Promise<UserRow> {
  const rows = await db
    .insert(users)
    .values({
      adapterId: identity.adapterId,
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email ?? null,
    })
    .onConflictDoUpdate({
      target: [users.adapterId, users.subject],
      set: { displayName: identity.displayName, email: identity.email ?? null },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("upsertUserByIdentity returned no row");
  }
  return row;
}

export async function findUserById(db: Database, id: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

/* ---------- 设备 ---------- */

export interface NewDevice {
  userId: string;
  name: string;
  platform: string;
  clientVersion: string;
}

/** 设备归属只来自令牌里的 sub，由调用方传入；这里不接受调用方指定的用户。 */
export async function createDevice(db: Database, device: NewDevice): Promise<DeviceRow> {
  const rows = await db
    .insert(devices)
    .values({
      userId: device.userId,
      name: device.name,
      platform: device.platform,
      clientVersion: device.clientVersion,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("createDevice returned no row");
  }
  return row;
}

export async function listDevicesForUser(db: Database, userId: string): Promise<DeviceRow[]> {
  return db
    .select()
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.createdAt));
}

/* ---------- 模型目录 ---------- */

export interface ModelSeed {
  id: string;
  displayName: string;
  contextWindow: number;
  endpoint: ModelEndpointRow;
  upstreamModel: string;
}

/** 只在目录为空时写入，不用来更新已有条目。目录的日常维护入口在一期。 */
export async function seedModelCatalogIfEmpty(db: Database, seeds: ModelSeed[]): Promise<void> {
  const existing = await db.select({ id: models.id }).from(models).limit(1);
  if (existing.length > 0) {
    return;
  }
  const endpoints = new Map<string, ModelEndpointRow>();
  for (const seed of seeds) {
    endpoints.set(seed.endpoint.id, seed.endpoint);
  }
  await db.transaction(async (tx) => {
    for (const endpoint of endpoints.values()) {
      await tx
        .insert(modelEndpoints)
        .values(endpoint)
        .onConflictDoNothing({ target: modelEndpoints.id });
    }
    for (const seed of seeds) {
      await tx
        .insert(models)
        .values({
          id: seed.id,
          endpointId: seed.endpoint.id,
          upstreamModel: seed.upstreamModel,
          displayName: seed.displayName,
          contextWindow: seed.contextWindow,
          enabled: 1,
        })
        .onConflictDoNothing({ target: models.id });
    }
  });
}

export interface ModelWithEndpoint {
  model: ModelRow;
  endpoint: ModelEndpointRow;
}

/** 目录的首位使用者是客户端，按 id 排序保证每次返回顺序一致。 */
export async function listEnabledModels(db: Database): Promise<ModelWithEndpoint[]> {
  const rows = await db
    .select({ model: models, endpoint: modelEndpoints })
    .from(models)
    .innerJoin(modelEndpoints, eq(models.endpointId, modelEndpoints.id))
    .where(eq(models.enabled, 1))
    .orderBy(models.id);
  return rows;
}

export async function findEnabledModel(
  db: Database,
  modelId: string,
): Promise<ModelWithEndpoint | undefined> {
  const rows = await db
    .select({ model: models, endpoint: modelEndpoints })
    .from(models)
    .innerJoin(modelEndpoints, eq(models.endpointId, modelEndpoints.id))
    .where(and(eq(models.id, modelId), eq(models.enabled, 1)))
    .limit(1);
  return rows[0];
}

/* ---------- 用量 ---------- */

export type UsageEventInput = Omit<NewUsageEvent, "id" | "errorKind"> & {
  errorKind: UsageErrorKind | null;
};

/** request_id 重复时不报错，也不覆盖第一次的结果。返回是否真的写入。 */
export async function insertUsageEvent(db: Database, event: UsageEventInput): Promise<boolean> {
  const inserted = await db
    .insert(usageEvents)
    .values(event)
    .onConflictDoNothing({ target: usageEvents.requestId })
    .returning({ id: usageEvents.id });
  return inserted.length > 0;
}

export interface UsageCursor {
  occurredAt: Date;
  id: string;
}

export function encodeUsageCursor(cursor: UsageCursor): string {
  return Buffer.from(JSON.stringify([cursor.occurredAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

export function decodeUsageCursor(cursor: string): UsageCursor {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  if (
    !Array.isArray(payload) ||
    typeof payload[0] !== "string" ||
    typeof payload[1] !== "string" ||
    !Number.isFinite(Date.parse(payload[0]))
  ) {
    throw new Error("invalid usage cursor");
  }
  return { occurredAt: new Date(payload[0]), id: payload[1] };
}

/**
 * 按 (occurred_at, id) 倒序的键集分页。排序键里带上 id，是因为同一毫秒可能落多条记录，
 * 只按时间翻页会漏或重。多取一行用来判断有没有下一页。
 */
export async function listUsageEvents(
  db: Database,
  options: { limit: number; cursor?: UsageCursor },
): Promise<{ rows: UsageEventRow[]; nextCursor: UsageCursor | null }> {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(
      options.cursor
        ? sql`(${usageEvents.occurredAt}, ${usageEvents.id}) < (${options.cursor.occurredAt}, ${options.cursor.id})`
        : undefined,
    )
    .orderBy(desc(usageEvents.occurredAt), desc(usageEvents.id))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}
