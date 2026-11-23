import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 登录过程中间状态的封存件。浏览器被带到客户身份系统再带回来，之后还要多经一次跳转
 * 才回到交互自己的路径上，中间靠它记住进行到了哪一步。
 * 用 HMAC 加签：内容可以不加密，但改一个字节就会在核对时被拒。
 *
 * 分两步，凭 step 字段区分，互相不能顶替：
 * - redirect：正把浏览器带去客户身份系统，等它回来。
 * - finish：客户身份系统已经认下了这个人，等交互路由把登录结束掉。
 */
interface RedirectTransaction {
  step: "redirect";
  /** OIDC Provider 分配的交互标识。回调时、结束登录时都要与当前交互一致。 */
  interactionUid: string;
  adapterId: string;
  state: string;
  codeVerifier: string;
  /** 封存的时间，毫秒。 */
  issuedAt: number;
}

interface FinishTransaction {
  step: "finish";
  interactionUid: string;
  /** 客户身份系统认下的那个人，在管控平面里的用户标识。 */
  accountId: string;
  issuedAt: number;
}

export type AuthTransaction = RedirectTransaction | FinishTransaction;

/** 封存时不带封存时间，它由封存函数填上。 */
export type AuthTransactionInput =
  | Omit<RedirectTransaction, "issuedAt">
  | Omit<FinishTransaction, "issuedAt">;

export interface SealOptions {
  key: string;
}

export interface OpenOptions {
  key: string;
  maxAgeMs: number;
  now?: number;
}

export function createLoginState(): string {
  return randomBytes(32).toString("base64url");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function sealAuthTransaction(txn: AuthTransactionInput, options: SealOptions): string {
  const payload = Buffer.from(JSON.stringify({ ...txn, issuedAt: Date.now() }), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, options.key)}`;
}

/** 签名不对、结构不对、过期，都返回 undefined。调用方只区分“能用”和“不能用”。 */
export function openAuthTransaction(
  value: string | undefined,
  options: OpenOptions,
): AuthTransaction | undefined {
  if (!value) {
    return undefined;
  }
  const separator = value.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return undefined;
  }
  const expected = sign(payload, options.key);
  const given = Buffer.from(signature, "ascii");
  const wanted = Buffer.from(expected, "ascii");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return undefined;
  }
  const txn = parseTransaction(payload);
  if (!txn) {
    return undefined;
  }
  const now = options.now ?? Date.now();
  if (txn.issuedAt > now + 30_000 || now - txn.issuedAt > options.maxAgeMs) {
    return undefined;
  }
  return txn;
}

/** 签名通过之后再看内容。每一步各自要求自己的字段齐全；不认识的步骤一律不认。 */
function parseTransaction(payload: string): AuthTransaction | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.interactionUid !== "string" || typeof record.issuedAt !== "number") {
    return undefined;
  }
  const common = { interactionUid: record.interactionUid, issuedAt: record.issuedAt };
  if (record.step === "redirect") {
    if (
      typeof record.adapterId !== "string" ||
      typeof record.state !== "string" ||
      typeof record.codeVerifier !== "string"
    ) {
      return undefined;
    }
    return {
      step: "redirect",
      ...common,
      adapterId: record.adapterId,
      state: record.state,
      codeVerifier: record.codeVerifier,
    };
  }
  if (record.step === "finish") {
    if (typeof record.accountId !== "string" || record.accountId === "") {
      return undefined;
    }
    return { step: "finish", ...common, accountId: record.accountId };
  }
  return undefined;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function buildSetCookie(input: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const attrs = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    "Path=/",
    "HttpOnly",
    // 回调是从客户身份系统带回来的顶层跳转，Lax 足够，同时挡住第三方站点发起的跨站请求。
    "SameSite=Lax",
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (input.secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}
