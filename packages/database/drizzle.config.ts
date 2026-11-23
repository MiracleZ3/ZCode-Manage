import { defineConfig } from "drizzle-kit";

// 只用来生成迁移文件，不连数据库。地址仅供 push、studio 等需要连库的命令使用。
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env["ZM_DATABASE_URL"] ?? "postgres://zm:zm@127.0.0.1:5432/zm",
  },
});
