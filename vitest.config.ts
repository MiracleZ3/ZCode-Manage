import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 构建期常量在测试态由这里注入；真实值由各应用的 tsup.config.ts 决定。
  define: {
    __ZM_VERSION__: JSON.stringify("0.0.0-test"),
    __ZM_MIGRATIONS_DIR__: JSON.stringify(
      resolve(import.meta.dirname, "packages/database/migrations"),
    ),
  },
  test: {
    // 单元测试在各包的 test/ 目录，不依赖任何外部服务，提交前全部执行。
    // 集成测试需要开发栈（PostgreSQL、Keycloak），单独成一个项目，按需运行。
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          exclude: ["**/integration/**", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["apps/*/test/integration/**/*.test.ts", "test/integration/**/*.test.ts"],
          // 集成测试共用一个数据库，串行执行，免得互相清表。
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
    // 通过的用例不转发 console 输出，避免日志把门禁输出刷爆；失败用例的日志原样保留。
    silent: "passed-only",
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
