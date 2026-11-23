import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

// tsup 配置可能从不同 cwd 加载，基于配置文件自身目录解析文件位置。
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8"),
) as { version: string };
const migrationsDir = resolve(import.meta.dirname, "../../packages/database/migrations");

export default defineConfig({
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  // 保留 node: 前缀，避免打包器把内置模块解析成同名的第三方包。
  removeNodeProtocol: false,
  target: "es2024",
  // workspace 包的 exports 指向 .ts 源码，Node 运行时不能直接加载，需要打包进来。
  noExternal: ["@zm/contracts", "@zm/shared", "@zm/database"],
  clean: true,
  sourcemap: true,
  define: {
    __ZM_VERSION__: JSON.stringify(packageJson.version),
    // 迁移目录在构建期按源码位置算出；打包后 import.meta.url 指向 dist，不能再按它去找。
    __ZM_MIGRATIONS_DIR__: JSON.stringify(migrationsDir),
  },
});
