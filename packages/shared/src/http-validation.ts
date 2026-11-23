import type { Context } from "hono";
import { apiErrorSchema } from "@zm/contracts";
import type { z } from "zod";

export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

type ServiceEnv = { Variables: { requestId: string } };

export interface ValidationIssue {
  path: string;
  message: string;
}

function validationError<E extends ServiceEnv>(
  c: Context<E>,
  issues: readonly ValidationIssue[],
): Response {
  // 只回传“哪个字段、什么问题”，不回传收到的值，避免把敏感内容原样送回去。
  const summary = issues
    .slice(0, 20)
    .map((issue) => `${issue.path || "(root)"}: ${issue.message}`)
    .join("; ")
    .slice(0, 500);
  return c.json(
    apiErrorSchema.parse({
      error: {
        code: "validation_error",
        message: `Request validation failed: ${summary}`,
        requestId: c.get("requestId"),
      },
    }),
    400,
  );
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** 校验查询参数。查询字符串里都是字符串，schema 里要用 coerce 或字面量。 */
export function parseQuery<E extends ServiceEnv, S extends z.ZodType>(
  c: Context<E>,
  schema: S,
): ParseResult<z.output<S>> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(c.req.url).searchParams.entries()) {
    const existing = query[key];
    query[key] = existing === undefined ? value : [existing, value].flat();
  }
  const result = schema.safeParse(query);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, response: validationError(c, toIssues(result.error)) };
}

/** 校验 JSON 请求体。没有请求体或不是 JSON 同样是 400，不是 500。 */
export async function parseJsonBody<E extends ServiceEnv, S extends z.ZodType>(
  c: Context<E>,
  schema: S,
): Promise<ParseResult<z.output<S>>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return {
      ok: false,
      response: validationError(c, [{ path: "", message: "body must be valid JSON" }]),
    };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, response: validationError(c, toIssues(result.error)) };
}
