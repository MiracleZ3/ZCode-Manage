#!/usr/bin/env node

// 生成本机开发用的应用环境文件 deploy/dev/apps.env。密钥每次随机生成，
// 所以仓库里不需要、也不应该提交任何凭据字面量。pnpm dev 用 node 自带的
// --env-file 读取它，再由 scripts/dev-apps.mjs 起应用进程；应用自身不读 .env 文件。

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(import.meta.dirname, "../deploy/dev/apps.env");

if (existsSync(target)) {
  // 已经有了就不覆盖：随机生成的密钥要保持稳定，否则重启后旧令牌和登录状态都会失效。
  process.exit(0);
}

const secret = (bytes) => randomBytes(bytes).toString("hex");

// 开发时只有一个来源：Vite 开发服务器。页面、管理接口、OIDC 端点都在它的地址下，
// 由它代理到管理接口。这样浏览器里发出的每个请求都与页面同源，产品代码里不必为开发
// 环境开放跨域。正式部署时由反向代理承担同样的角色，所以两边拓扑一致。
// 端口与 apps/console/vite.config.ts 里写死的要保持一致：颁发者地址会写进令牌与每一跳登录流程。
const issuer = "http://localhost:5173";
const consoleClientId = "zm-console-dev";

// 客户端清单：一个服务账号客户端（给脚本、CI 和出口脚本用），两个公共客户端
// （企业版客户端与控制台，走授权码加 PKCE）。这里的值只在本机开发栈里有效。
const oidcClients = [
  {
    clientId: "zm-service-dev",
    clientSecret: secret(16),
    redirectUris: [],
    grantTypes: ["client_credentials"],
    scope: "model:invoke",
    tokenEndpointAuthMethod: "client_secret_post",
  },
  {
    clientId: "zcode-ee-dev",
    redirectUris: ["http://127.0.0.1:53682/callback", "zcode-ee://oauth/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    scope: "openid profile offline_access model:invoke device:register",
    tokenEndpointAuthMethod: "none",
  },
  {
    clientId: consoleClientId,
    redirectUris: ["http://localhost:5173/callback"],
    // 退出登录之后回到首页。与登录回调一样要逐个登记，控制台在 auth.ts 里登记的就是这个地址。
    postLogoutRedirectUris: ["http://localhost:5173/"],
    grantTypes: ["authorization_code", "refresh_token"],
    scope: "openid profile offline_access usage:read device:register",
    tokenEndpointAuthMethod: "none",
  },
];

// 登录适配器指向开发栈里的 Keycloak。上游客户端与用户的凭据定义在
// deploy/dev/keycloak/zcode-ee-dev-realm.json 里，由 Keycloak 启动时导入。
// 开发栈里的 Keycloak 是明文 HTTP；这只对本机回环地址开放，所以必须显式打开。
const authAdapters = [
  {
    id: "keycloak-dev",
    kind: "oidc-upstream",
    issuer: "http://localhost:8180/realms/zcode-ee-dev",
    clientId: "zcode-manage",
    clientSecret: "zcode-manage-dev-upstream-secret",
    allowInsecureHttp: true,
  },
];

// 模型目录的种子数据：只有一个指向本机替身服务的端点。
const upstreamApiKey = secret(16);
const seedModels = [
  {
    id: "glm-dev",
    displayName: "GLM（本地替身）",
    contextWindow: 128000,
    endpointId: "mock-openai",
    baseUrl: "http://127.0.0.1:8082/v1",
    upstreamModel: "glm-dev",
  },
];

const lines = [
  "# 本机开发用的应用环境。由 scripts/dev-env.mjs 生成，不要提交，也不要放真实凭据。",
  "# 要重新生成：先删除本文件，再执行 pnpm dev:env。",
  "",
  "# 三个服务共用",
  "ZM_LOG_LEVEL=debug",
  "ZM_DATABASE_URL=postgres://zm:zm-dev-password@127.0.0.1:5432/zm",
  "",
  "# 控制台的部署期配置：它在运行时经 /runtime-config.js 读到下面的值",
  `ZM_CONSOLE_CLIENT_ID=${consoleClientId}`,
  "",
  "# manage-api 与 model-gateway",
  // 颁发者只有一个，两个服务各自用一个变量读它。网关核对令牌里的签发者，对不上就把令牌全拒掉，
  // 所以这两行必须来自上面同一个常量，不要各写各的。
  `ZM_PUBLIC_BASE_URL=${issuer}`,
  `ZM_ISSUER=${issuer}`,
  "ZM_GATEWAY_BASE_URL=http://localhost:8081",
  `ZM_AUTH_STATE_KEY=${secret(32)}`,
  `ZM_OIDC_CLIENTS_JSON=${JSON.stringify(oidcClients)}`,
  `ZM_AUTH_ADAPTERS_JSON=${JSON.stringify(authAdapters)}`,
  `ZM_SEED_MODELS_JSON=${JSON.stringify(seedModels)}`,
  "",
  "# model-gateway 与 mock-model：上游密钥的名字由种子数据约定",
  `ZM_UPSTREAM_API_KEY=${upstreamApiKey}`,
  `ZM_MOCK_API_KEY=${upstreamApiKey}`,
  "",
];

writeFileSync(target, lines.join("\n"), { mode: 0o600 });
console.log(`[dev-env] 已生成 ${target}（权限 600）。密钥为本机随机值，已被 .gitignore 忽略。`);
