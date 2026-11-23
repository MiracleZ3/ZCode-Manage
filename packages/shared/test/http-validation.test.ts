import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody, parseQuery } from "../src/index.js";

type Env = { Variables: { requestId: string } };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(5),
  cursor: z.string().optional(),
});

/** strict 让“多了未知字段”也成为校验失败。 */
const bodySchema = z
  .object({
    name: z.string().trim().min(1),
    secret: z.string().min(3),
    platform: z.enum(["darwin", "win32"]),
  })
  .strict();

function createTestApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-7");
    await next();
  });
  app.get("/q", (c) => {
    const query = parseQuery(c, querySchema);
    return query.ok ? c.json(query.data) : query.response;
  });
  app.post("/b", async (c) => {
    const body = await parseJsonBody(c, bodySchema);
    return body.ok ? c.json(body.data) : body.response;
  });
  return app;
}

async function postJson(app: Hono<Env>, body: unknown): Promise<Response> {
  return app.request("/b", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseQuery", () => {
  it("查询字符串都是字符串：coerce 负责转成数字，缺省走默认值", async () => {
    const app = createTestApp();

    expect(await (await app.request("/q?limit=3")).json()).toEqual({ limit: 3 });
    expect(await (await app.request("/q")).json()).toEqual({ limit: 5 });
    expect(await (await app.request("/q?limit=2&cursor=abc")).json()).toEqual({
      limit: 2,
      cursor: "abc",
    });
  });

  it("超出范围或不是数字：400，错误体里指明字段", async () => {
    const app = createTestApp();
    const response = await app.request("/q?limit=99");
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: "validation_error", requestId: "req-7" });
    expect(body.error.message).toContain("limit");
    expect((await app.request("/q?limit=abc")).status).toBe(400);
  });
});

describe("parseJsonBody", () => {
  it("合法请求体通过，并按 schema 裁剪", async () => {
    const response = await postJson(createTestApp(), {
      name: "  dev ",
      secret: "abc",
      platform: "darwin",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "dev", secret: "abc", platform: "darwin" });
  });

  it("不是 JSON：400，不是 500", async () => {
    const response = await createTestApp().request("/b", { method: "POST", body: "not json" });

    expect(response.status).toBe(400);
  });

  it("少了必填字段、多了未知字段、字段格式不对：都是 400", async () => {
    const app = createTestApp();

    expect((await postJson(app, { secret: "abc", platform: "darwin" })).status).toBe(400);
    expect(
      (await postJson(app, { name: "d", secret: "abc", platform: "darwin", extra: 1 })).status,
    ).toBe(400);
    expect((await postJson(app, { name: "d", secret: "x", platform: "darwin" })).status).toBe(400);
  });

  it("错误信息不回传收到的值，避免把口令原样送回去", async () => {
    const response = await postJson(createTestApp(), {
      name: "d",
      secret: "hunter2",
      platform: "darwin",
      extra: 1,
    });

    expect(await response.text()).not.toContain("hunter2");
  });
});
