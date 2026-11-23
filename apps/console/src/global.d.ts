// 部署期配置在应用启动前由 /runtime-config.js 挂到 window 上，见 vite.config.ts。
interface Window {
  __ZM_RUNTIME_CONFIG__?: Record<string, unknown>;
}
