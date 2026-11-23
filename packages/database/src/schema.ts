import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * 本期需要的最小数据集，对应规格第 6 节。
 * 时间一律带时区；主键用 UUID，由数据库生成，应用不关心它的取值。
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 建档来自哪个鉴权适配器，与 subject 一起唯一。 */
    adapterId: text("adapter_id").notNull(),
    /** 客户身份系统里的主体标识。 */
    subject: text("subject").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_adapter_subject_uq").on(table.adapterId, table.subject)],
);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  clientVersion: text("client_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modelEndpoints = pgTable("model_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  baseUrl: text("base_url").notNull(),
  /** 上游访问密钥所在环境变量的名字。数据库里不存密钥本身。 */
  apiKeyEnv: text("api_key_env").notNull(),
});

export const models = pgTable("models", {
  /** 即客户端请求里写的 model。 */
  id: text("id").primaryKey(),
  endpointId: text("endpoint_id")
    .notNull()
    .references(() => modelEndpoints.id),
  upstreamModel: text("upstream_model").notNull(),
  displayName: text("display_name").notNull(),
  contextWindow: integer("context_window").notNull(),
  enabled: integer("enabled").notNull().default(1),
});

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 幂等键。网关为每个请求生成一次，重复写入被唯一约束挡住。 */
  requestId: text("request_id").notNull().unique(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectName: text("subject_name").notNull(),
  clientId: text("client_id").notNull(),
  model: text("model").notNull(),
  upstreamModel: text("upstream_model").notNull(),
  endpointId: text("endpoint_id").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  statusCode: integer("status_code").notNull(),
  stream: integer("stream").notNull(),
  durationMs: integer("duration_ms"),
  usageSource: text("usage_source").notNull(),
  errorKind: text("error_kind"),
});

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type ModelEndpointRow = typeof modelEndpoints.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
