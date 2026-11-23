import type { Device } from "@zm/contracts";
import {
  bootstrapResponseSchema,
  deviceListResponseSchema,
  deviceSchema,
  modelListResponseSchema,
  registerDeviceRequestSchema,
} from "@zm/contracts";
import type { Hono } from "hono";
import { getClaims, parseJsonBody, type AuthEnv } from "@zm/shared";
import type { DeviceRow, ModelWithEndpoint } from "@zm/database";
import type { ManageServices } from "../services.js";

export function registerClientRoutes(app: Hono<AuthEnv>, services: ManageServices): void {
  const { config, auth } = services;
  const issuer = config.publicBaseUrl.replace(/\/$/, "");
  const connect = (path: string) => `${issuer}${path}`;

  // C1 引导配置：公开可读。客户端启动时请求一次，据此知道去哪里登录。
  app.get("/em/v1/bootstrap", (c) =>
    c.json(
      bootstrapResponseSchema.parse({
        issuer: config.publicBaseUrl,
        authorizationEndpoint: connect("/connect/authorize"),
        tokenEndpoint: connect("/connect/token"),
        jwksUri: connect("/connect/jwks"),
        gatewayBaseUrl: config.gatewayBaseUrl,
        minimalClientVersion: config.minimalClientVersion,
        heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      }),
    ),
  );

  // C5 模型目录：只返回启用的模型，顺序固定。
  app.get("/em/v1/models", auth.requireToken, async (c) => {
    const rows = await services.listModels();
    return c.json(modelListResponseSchema.parse({ models: rows.map(toModel) }));
  });

  // C3 设备注册：归属只取令牌里的 sub。
  app.post("/em/v1/devices", auth.requireToken, auth.requireScope("device:register"), async (c) => {
    const body = await parseJsonBody(c, registerDeviceRequestSchema);
    if (!body.ok) {
      return body.response;
    }
    const claims = getClaims(c);
    const device = await services.registerDevice({ userId: claims.sub, device: body.data });
    return c.json(deviceSchema.parse(toDevice(device)), 201);
  });

  app.get("/em/v1/devices", auth.requireToken, auth.requireScope("device:register"), async (c) => {
    const claims = getClaims(c);
    const devices = await services.listDevices(claims.sub);
    return c.json(deviceListResponseSchema.parse({ devices: devices.map(toDevice) }));
  });
}

function toModel({ model, endpoint }: ModelWithEndpoint) {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    endpointId: endpoint.id,
  };
}

function toDevice(row: DeviceRow): Device {
  return {
    deviceId: row.id,
    name: row.name,
    platform: row.platform as Device["platform"],
    clientVersion: row.clientVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
