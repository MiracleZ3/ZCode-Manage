import { describe, expect, it } from "vitest";
import {
  buildSetCookie,
  createLoginState,
  openAuthTransaction,
  readCookie,
  sealAuthTransaction,
} from "../src/idp/state-cookie.js";

const KEY = "unit-test-state-key-0123456789abcdef";
const MAX_AGE_MS = 10 * 60 * 1000;

function createRedirectTransaction(overrides: Record<string, unknown> = {}) {
  return {
    step: "redirect" as const,
    interactionUid: "uid-1",
    adapterId: "keycloak-dev",
    state: createLoginState(),
    codeVerifier: "verifier-1",
    ...overrides,
  };
}

function createFinishTransaction(overrides: Record<string, unknown> = {}) {
  return {
    step: "finish" as const,
    interactionUid: "uid-1",
    accountId: "user-1",
    ...overrides,
  };
}

/** 封存时用的是真实时钟，所以核对有效性也用真实时钟，只挪动偏移量。 */
function open(value: string | undefined, options: { key?: string; ageMs?: number } = {}) {
  return openAuthTransaction(value, {
    key: options.key ?? KEY,
    maxAgeMs: MAX_AGE_MS,
    now: Date.now() + (options.ageMs ?? 0),
  });
}

describe("登录状态的封存", () => {
  it("两步的封存件都能原样取回", () => {
    const redirect = createRedirectTransaction();
    const finish = createFinishTransaction();

    expect(open(sealAuthTransaction(redirect, { key: KEY }))).toMatchObject({
      step: "redirect",
      interactionUid: "uid-1",
      adapterId: "keycloak-dev",
      state: redirect.state,
      codeVerifier: "verifier-1",
    });
    expect(open(sealAuthTransaction(finish, { key: KEY }))).toMatchObject({
      step: "finish",
      interactionUid: "uid-1",
      accountId: "user-1",
    });
  });

  it("内容被改动一个字节就取不回", () => {
    const sealed = sealAuthTransaction(createRedirectTransaction(), { key: KEY });
    const payload = sealed.slice(0, sealed.indexOf("."));
    const forgedState = Buffer.from(
      JSON.stringify({
        ...createRedirectTransaction({ state: "attacker-state" }),
        issuedAt: Date.now(),
      }),
    ).toString("base64url");

    expect(open(sealed.replace(payload, forgedState))).toBeUndefined();
  });

  it("把第一步的封存件改成第二步的样子，取不回：步骤在签名保护的范围内", () => {
    const sealed = sealAuthTransaction(createRedirectTransaction(), { key: KEY });
    const payload = sealed.slice(0, sealed.indexOf("."));
    const forgedStep = Buffer.from(
      JSON.stringify({ ...createFinishTransaction(), issuedAt: Date.now() }),
    ).toString("base64url");

    expect(open(sealed.replace(payload, forgedStep))).toBeUndefined();
  });

  it("某一步缺了自己要求的字段，即使签名有效也不认", () => {
    const noVerifier = createRedirectTransaction({ codeVerifier: undefined });
    const noAccount = createFinishTransaction({ accountId: "" });

    expect(open(sealAuthTransaction(noVerifier, { key: KEY }))).toBeUndefined();
    expect(open(sealAuthTransaction(noAccount, { key: KEY }))).toBeUndefined();
  });

  it("用别的密钥签的不认；换一个 state 也不认", () => {
    const sealed = sealAuthTransaction(createRedirectTransaction(), { key: KEY });

    expect(open(sealed, { key: "another-key-another-key-another" })).toBeUndefined();
    expect(open(`${sealed.slice(0, -2)}xx`)).toBeUndefined();
  });

  it("超过有效期的取不回；恰好没过期可以", () => {
    const sealed = sealAuthTransaction(createRedirectTransaction(), { key: KEY });

    expect(open(sealed, { ageMs: MAX_AGE_MS + 1 })).toBeUndefined();
    expect(open(sealed, { ageMs: MAX_AGE_MS })).toBeDefined();
    expect(open(sealed, { ageMs: 0 })).toBeDefined();
  });

  it("格式不对的一律拒绝：空值、没有分隔点、不是 base64url", () => {
    for (const value of [undefined, "", "nodot", "a.b c", "!!!.???", "e30g.aXNVbmvkeQ"]) {
      expect(open(value)).toBeUndefined();
    }
  });

  it("签名字段的比较不因长度不同而抛异常", () => {
    const sealed = sealAuthTransaction(createRedirectTransaction(), { key: KEY });

    expect(open(`${sealed.slice(0, sealed.indexOf("."))}.short`)).toBeUndefined();
  });

  it("state 足够长且每次不同", () => {
    const first = createLoginState();
    const second = createLoginState();

    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
  });
});

describe("Cookie 的读写", () => {
  it("写入时带 HttpOnly、SameSite 与有效期；https 时再加 Secure", () => {
    const cookie = buildSetCookie({
      name: "zm_auth_txn",
      value: "abc.def",
      maxAgeSeconds: 600,
      secure: false,
    });

    expect(cookie).toBe("zm_auth_txn=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=600");
    expect(
      buildSetCookie({ name: "zm_auth_txn", value: "abc", maxAgeSeconds: 0, secure: true }),
    ).toContain("Secure");
  });

  it("从 Cookie 请求头里按名字取值；值里有分隔符或被编码也能取对", () => {
    const header = `other=1; zm_auth_txn=${encodeURIComponent("a.b=c")}; second=2`;

    expect(readCookie(header, "zm_auth_txn")).toBe("a.b=c");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(undefined, "zm_auth_txn")).toBeUndefined();
  });
});
