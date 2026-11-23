import { describe, expect, it } from "vitest";
import { createCookieJar } from "./integration/support/stack.js";

/** 一个只带 Set-Cookie 的响应。 */
function responseWithCookies(...cookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

describe("集成测试用的 Cookie 罐", () => {
  // 管控平面把交互会话的 Cookie 限定在交互自己的路径下。罐子若不看路径，
  // 集成测试就会把它送到客户身份系统的回调地址上，替真实浏览器做了一件它不会做的事。
  it("限定在某条路径下的 Cookie，只发给这条路径之下的请求", () => {
    const jar = createCookieJar();
    jar.absorb(
      responseWithCookies("_interaction=secret; path=/interaction/abc; samesite=lax; httponly"),
      "http://idp.test/interaction/abc",
    );

    expect(jar.header("http://idp.test/auth/callback/keycloak-dev")).toBe("");
    expect(jar.header("http://idp.test/interaction/abcd")).toBe("");
    expect(jar.header("http://idp.test/interaction")).toBe("");
    expect(jar.header("http://idp.test/interaction/abc/finish")).toBe("_interaction=secret");
    expect(jar.header("http://idp.test/interaction/abc?x=1")).toBe("_interaction=secret");
  });

  it("没写 Path 时取请求路径所在的目录", () => {
    const jar = createCookieJar();
    jar.absorb(responseWithCookies("a=1"), "http://idp.test/em/v1/devices");
    jar.absorb(responseWithCookies("b=2"), "http://idp.test/connect/token");

    expect(jar.header("http://idp.test/em/v1/models")).toBe("a=1");
    expect(jar.header("http://idp.test/em/other")).toBe("");
    expect(jar.header("http://idp.test/connect/jwks")).toBe("b=2");
    expect(jar.header("http://idp.test/")).toBe("");
  });

  it("同名而路径不同的 Cookie 各存各的；作废只删同一名称同一路径的那一个", () => {
    const jar = createCookieJar();
    jar.absorb(responseWithCookies("zm=wide; path=/"), "http://idp.test/interaction/abc");
    jar.absorb(responseWithCookies("zm=narrow; path=/narrow"), "http://idp.test/interaction/abc");

    expect(jar.header("http://idp.test/narrow/page")).toContain("zm=wide");
    expect(jar.header("http://idp.test/narrow/page")).toContain("zm=narrow");

    jar.absorb(responseWithCookies("zm=; path=/; max-age=0"), "http://idp.test/anywhere");
    expect(jar.header("http://idp.test/narrow/page")).toBe("zm=narrow");
    expect(jar.header("http://idp.test/")).toBe("");
  });

  it("已经过期的 Cookie 不留；取值时按原样带回", () => {
    const jar = createCookieJar();
    jar.absorb(responseWithCookies("a=1"), "http://idp.test/");
    jar.absorb(
      responseWithCookies("a=0; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"),
      "http://idp.test/",
    );

    expect(jar.header("http://idp.test/")).toBe("");
  });
});
