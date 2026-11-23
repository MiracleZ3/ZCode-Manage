// 构建期由 tsup 的 define 注入（见 tsup.config.ts），测试态由 vitest.config.ts 注入。
declare const __ZM_VERSION__: string;

export const ZM_VERSION: string = __ZM_VERSION__;
