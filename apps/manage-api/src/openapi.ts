import type { ZodType } from "zod";
import { z } from "zod";
import {
  apiErrorSchema,
  bootstrapResponseSchema,
  deviceListResponseSchema,
  deviceSchema,
  healthResponseSchema,
  modelListResponseSchema,
  registerDeviceRequestSchema,
  usageEventPageSchema,
} from "@zm/contracts";
import type { ManageApiConfig } from "./config.js";

export interface EndpointDoc {
  method: "get" | "post";
  path: string;
  summary: string;
  /** none：公开。token：要求有效的访问令牌。 */
  auth: "none" | "token";
  /** 在 auth 为 token 时，还要求令牌范围里包含的范围。 */
  scopes?: readonly string[];
  /** 请求体的契约，按输入方向生成。 */
  request?: ZodType;
  /** 成功响应。鉴权与校验失败的响应按约定自动补上。 */
  responses: readonly { status: number; schema: ZodType }[];
}

/**
 * 对外接口的唯一清单。接口说明由它和契约里的 zod 定义生成；
 * 应用注册的路由必须与它逐条一致，由对照测试保证。
 */
export const ENDPOINTS: readonly EndpointDoc[] = [
  {
    method: "get",
    path: "/healthz",
    auth: "none",
    summary: "健康检查。只表示进程能应答，不表示依赖可用。",
    responses: [{ status: 200, schema: healthResponseSchema }],
  },
  {
    method: "get",
    path: "/em/v1/bootstrap",
    auth: "none",
    summary: "启动引导：登录入口、网关地址、最低客户端版本。",
    responses: [{ status: 200, schema: bootstrapResponseSchema }],
  },
  {
    method: "get",
    path: "/em/v1/models",
    auth: "token",
    summary: "模型目录。只返回启用的模型，顺序固定。",
    responses: [{ status: 200, schema: modelListResponseSchema }],
  },
  {
    method: "post",
    path: "/em/v1/devices",
    auth: "token",
    scopes: ["device:register"],
    summary: "注册设备。归属取自令牌里的 sub，不接受请求体指定用户。",
    request: registerDeviceRequestSchema,
    responses: [{ status: 201, schema: deviceSchema }],
  },
  {
    method: "get",
    path: "/em/v1/devices",
    auth: "token",
    scopes: ["device:register"],
    summary: "当前用户名下的设备。",
    responses: [{ status: 200, schema: deviceListResponseSchema }],
  },
  {
    method: "get",
    path: "/em/v1/usage/events",
    auth: "token",
    scopes: ["usage:read"],
    summary: "用量明细，按时间倒序做游标分页。",
    responses: [{ status: 200, schema: usageEventPageSchema }],
  },
];

const SECURITY_SCHEME = "bearerAuth";

/** OpenAPI 3.1 兼容 JSON Schema 2020-12，zod 4 可以直接转过去。 */
function jsonSchema(schema: ZodType, io: "input" | "output"): Record<string, unknown> {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
}

function jsonMedia(schema: ZodType, io: "output" | "input" = "output"): Record<string, unknown> {
  return { "application/json": { schema: jsonSchema(schema, io) } };
}

function describe(status: number, text: string, schema?: ZodType): Record<string, unknown> {
  return { description: text, ...(schema ? { content: jsonMedia(schema) } : {}) };
}

function toOperation(endpoint: EndpointDoc): Record<string, unknown> {
  const secured = endpoint.auth === "token";
  const scopes = endpoint.scopes ?? [];
  const responses = Object.fromEntries(
    endpoint.responses.map((response) => [
      String(response.status),
      describe(response.status, "OK", response.schema),
    ]),
  );
  if (endpoint.request) {
    responses[400] = describe(400, "请求体不符合契约", apiErrorSchema);
  }
  if (secured) {
    responses[401] = describe(401, "没有令牌，或令牌无效、已过期", apiErrorSchema);
    if (scopes.length > 0) {
      responses[403] = describe(403, "令牌有效，但缺少所需范围", apiErrorSchema);
    }
  }
  const operation: Record<string, unknown> = { summary: endpoint.summary, responses };
  if (secured) {
    operation.security = [{ [SECURITY_SCHEME]: [...scopes] }];
  }
  if (endpoint.request) {
    operation.requestBody = { required: true, content: jsonMedia(endpoint.request, "input") };
  }
  return operation;
}

export type OpenApiDocument = ReturnType<typeof createOpenApiDocument>;

export function createOpenApiDocument(config: Pick<ManageApiConfig, "publicBaseUrl">) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of ENDPOINTS) {
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method]: toOperation(endpoint) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ZCode-Manage API",
      description:
        "ZCode-EE 管控平面的接口。错误体统一为 { error: { code, message, requestId } }。",
      version: "0.0.0",
    },
    servers: [{ url: config.publicBaseUrl, description: "manage-api" }],
    components: {
      securitySchemes: {
        [SECURITY_SCHEME]: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "由 /connect/token 换到的访问令牌",
        },
      },
    },
    paths,
  };
}
