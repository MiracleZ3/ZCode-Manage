import { z } from "zod";
import { instantSchema, uuidSchema } from "./common.js";

/**
 * 访问令牌的载荷。网关与 /em/v1/* 只凭令牌里的声明确定归属，不回查数据库。
 * 标准声明（iss、sub、exp、aud 等）由 OIDC Provider 给出，这里只补充自定义部分。
 */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string().min(1),
  /** 用户令牌里有；client_credentials 换到的令牌里没有。 */
  "zm:accountType": z.enum(["user", "service"]),
  "zm:displayName": z.string(),
  "zm:orgId": z.string().min(1),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/** 自定义范围。openid、profile、offline_access 是标准范围，不在这里列。 */
export const customScopes = ["model:invoke", "device:register", "usage:read"] as const;
export type CustomScope = (typeof customScopes)[number];

/** 把 scope 字符串拆成集合。多个空格视为一个。 */
export function parseScopes(scope: string | undefined): Set<string> {
  return new Set((scope ?? "").split(/\s+/).filter((item) => item.length > 0));
}

export const bootstrapResponseSchema = z
  .object({
    /** OIDC 颁发者。设备注册、模型目录等接口的地址都由它派生。 */
    issuer: z.url(),
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
    jwksUri: z.url(),
    gatewayBaseUrl: z.url(),
    /** 低于这个版本的客户端必须先升级。语义与官方的 forceUpdate.minimalVersion 一致。 */
    minimalClientVersion: z.string().min(1),
    heartbeatIntervalSeconds: z.number().int().positive(),
  })
  .strict();
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const devicePlatformSchema = z.enum(["darwin", "win32", "linux", "unknown"]);

export const registerDeviceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    platform: devicePlatformSchema,
    clientVersion: z.string().trim().min(1).max(64),
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const deviceSchema = z
  .object({
    deviceId: uuidSchema,
    name: z.string(),
    platform: devicePlatformSchema,
    clientVersion: z.string(),
    createdAt: instantSchema,
  })
  .strict();
export type Device = z.infer<typeof deviceSchema>;

export const deviceListResponseSchema = z.object({ devices: z.array(deviceSchema) }).strict();
