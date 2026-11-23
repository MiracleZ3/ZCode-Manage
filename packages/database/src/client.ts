import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createLogger, type LoggerSink } from "@zm/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg, { type Pool } from "pg";
import * as schema from "./schema.js";

/** 带上 schema 之后 db.query 才有类型。 */
export type Database = NodePgDatabase<typeof schema>;

export interface CreateDatabaseOptions {
  connectionString: string;
  /** 连接池上限。每个进程只建一个池。 */
  maxConnections?: number;
  /** 仅供测试替换日志出口。 */
  logSink?: LoggerSink;
}

export function createDatabase(options: CreateDatabaseOptions): { db: Database; pool: Pool } {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    // 空闲连接超过这个时间就归还，避免开发时长时间挂着占连接。
    idleTimeoutMillis: 30_000,
  });
  const logger = createLogger("database:pool", { sink: options.logSink });
  pool.on("error", (error) => {
    // 空闲连接被数据库单方面断开时只会触发这个事件；不监听会让进程因未捕获异常退出。
    logger.error(undefined, "idle client error", error);
  });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * 应用迁移。多个实例同时启动时由迁移表上的锁串行化，重复执行是空操作。
 * 迁移目录默认从本包在 node_modules 里的位置推导；打包后 import.meta.url 指向产物目录，
 * 所以不能用相对于源文件的方式去找。
 */
export async function applyMigrations(
  db: Database,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const migrationsFolder =
    options.migrationsFolder ??
    resolve(
      dirname(createRequire(import.meta.url).resolve("@zm/database/package.json")),
      "migrations",
    );
  await migrate(db, { migrationsFolder });
}
