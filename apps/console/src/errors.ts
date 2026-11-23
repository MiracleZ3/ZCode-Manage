/** 把任意异常变成一句能显示给使用者的话。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
