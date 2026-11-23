/**
 * 容器编排注入的环境变量常带换行或空格。统一 trim 读取，空串按未设置处理，
 * 调用方才能用 `??` 写默认值。
 */
export function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
