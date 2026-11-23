// 开发时 Vite 就是那一个来源：页面、管理接口、OIDC 端点都在它的地址下，
// 下面这些路径经代理转给管理接口。正式部署时由反向代理承担同样的角色，
// 所以应用代码里一律写以 / 开头的相对地址，不拼主机名。
//
// 端口不能换：它是颁发者地址的一部分，登录流程里的每一跳都用绝对地址指回来。
// scripts/dev-env.mjs 里的颁发者取同一个值。

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const MANAGE_API = "http://127.0.0.1:8080";

/** 转给管理接口的路径。用写明的开头匹配，避免 /em 顺带匹配到别的路径。 */
const PROXIED_PATHS = [
  "/em/",
  "/connect/",
  "/interaction/",
  "/auth/callback/",
  "/.well-known/openid-configuration",
];

/**
 * 部署期配置在开发时从进程环境里现生成。pnpm dev 已经把 deploy/dev/apps.env 读进了环境，
 * 所以客户端标识只有那一处定义。构建产物用的是 public/runtime-config.js，由部署方在启动时重写。
 * 环境里没有这一项时给出空值，应用启动时会明确报出来，而不是带着错误的标识去登录。
 */
function runtimeConfigFromEnv(): Plugin {
  return {
    name: "zm-runtime-config",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/runtime-config.js", (_request, response) => {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(
          `window.__ZM_RUNTIME_CONFIG__ = ${JSON.stringify({ ZM_CONSOLE_CLIENT_ID: process.env.ZM_CONSOLE_CLIENT_ID ?? null })};`,
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runtimeConfigFromEnv()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      PROXIED_PATHS.map((prefix) => [`^${prefix}`, { target: MANAGE_API, changeOrigin: true }]),
    ),
  },
});
