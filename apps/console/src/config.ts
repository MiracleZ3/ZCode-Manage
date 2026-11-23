/** 部署期配置，由 /runtime-config.js 提供，见 vite.config.ts。 */
export interface ConsoleConfig {
  /** 控制台在颁发者那里登记的客户端标识。 */
  clientId: string;
}

function readConsoleConfig(): ConsoleConfig {
  const clientId = window.__ZM_RUNTIME_CONFIG__?.ZM_CONSOLE_CLIENT_ID;
  if (typeof clientId !== "string" || clientId.trim() === "") {
    // 缺了它就无法发起登录。明确报出来，而不是带着一个猜的值去试。
    throw new Error(
      "缺少部署期配置 ZM_CONSOLE_CLIENT_ID。开发时请通过 pnpm dev 启动；" +
        "部署时由入口脚本按环境变量重写 runtime-config.js。",
    );
  }
  return { clientId: clientId.trim() };
}

export const consoleConfig = readConsoleConfig();
