// 构建期由 tsup 的 define 注入（见 tsup.config.ts），测试态由 vitest.config.ts 注入。
declare const __ZM_VERSION__: string;
declare const __ZM_MIGRATIONS_DIR__: string;

export const ZM_VERSION: string = __ZM_VERSION__;

/** 数据库迁移目录。按源码位置在构建期算出；容器里在同一路径布局下构建，所以同样成立。 */
export const ZM_MIGRATIONS_DIR: string = __ZM_MIGRATIONS_DIR__;
