import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

/** 测试专用的数据库名。每次运行都重建，不碰开发库里的数据。 */
export const TEST_DATABASE = "zm_integration_test";

/** 从本文件向上五级是仓库根目录：support → integration → test → manage-api → apps → 仓库根。 */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

export interface DevStack {
  /** 不带库名，形如 postgres://user:password@host:port */
  databaseUrl: string;
  keycloak: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
  };
}

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || separator <= 0) {
      continue;
    }
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

/**
 * 凭据不写在测试源码里：数据库地址读自 stack.env，
 * 上游客户端与测试用户读自 Keycloak 启动时导入的 realm 文件。
 */
export function readDevStack(): DevStack {
  const stack = readEnvFile(resolve(REPO_ROOT, "deploy/dev/stack.env"));
  const realm = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "deploy/dev/keycloak/zcode-ee-dev-realm.json"), "utf8"),
  ) as {
    realm: string;
    clients: { clientId: string; secret: string }[];
    users: { username: string; credentials: { value: string }[] }[];
  };
  const client = realm.clients[0];
  const user = realm.users[0];
  if (!client || !user?.credentials[0]) {
    throw new Error("开发用的 realm 必须定义上游客户端和一个测试用户");
  }
  const port = stack["ZM_DEV_KEYCLOAK_PORT"] || "8180";
  return {
    databaseUrl: `postgres://${stack["ZM_DEV_DB_USER"]}:${stack["ZM_DEV_DB_PASSWORD"]}@127.0.0.1:${stack["ZM_DEV_DB_PORT"]}`,
    keycloak: {
      issuer: `http://localhost:${port}/realms/${realm.realm}`,
      clientId: client.clientId,
      clientSecret: client.secret,
      username: user.username,
      password: user.credentials[0].value,
    },
  };
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface CookieJar {
  /** 把响应里的 Set-Cookie 收进来。要给出这次请求的地址，Cookie 的作用路径按它来定。 */
  absorb(response: Response, requestUrl: string): void;
  /** 拼出下一次访问这个地址时要带的 Cookie 头。 */
  header(requestUrl: string): string;
}

interface StoredCookie {
  name: string;
  /** Cookie 限定的路径。 */
  path: string;
  value: string;
}

/** RFC 6265 的路径匹配：路径相同，或者请求路径在它之下且分隔处是斜杠。 */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  return (
    requestPath === cookiePath ||
    (requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))
  );
}

/** 没写 Path 时取请求路径所在的目录；根目录下的请求归到 /。 */
function defaultPath(requestPath: string): string {
  const cut = requestPath.lastIndexOf("/");
  return cut <= 0 ? "/" : requestPath.slice(0, cut);
}

/**
 * 按 Cookie 的真实规则挑着发的极简 Cookie 罐。只实现了本流程用得到的部分：
 * 名字加路径区分；Path 限定它在哪条路径之下才发；Max-Age=0 或已过期的即删除。
 * 不看 Secure 与 SameSite：这里的请求全部是明文 HTTP 上的顶层跳转，两者都不影响结果。
 *
 * 路径必须看。管控平面把交互会话的 Cookie 限定在 /interaction/{uid} 之下，这是它有意的防护。
 * 早先的版本“只按名字存取”，把这个 Cookie 也送到了不该收到它的路径上，于是集成测试一直通过，
 * 真实浏览器里却登录不了。
 */
export function createCookieJar(): CookieJar {
  const cookies = new Map<string, StoredCookie>();

  return {
    absorb(response, requestUrl) {
      const requestPath = new URL(requestUrl).pathname;
      for (const cookie of response.headers.getSetCookie()) {
        const segments = cookie.split(";");
        const pair = segments[0] ?? "";
        const attributes = segments.slice(1);
        const separator = pair.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        let path = defaultPath(requestPath);
        let expired = false;
        for (const attribute of attributes) {
          const equals = attribute.indexOf("=");
          const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
          const attributeValue = equals === -1 ? "" : attribute.slice(equals + 1).trim();
          if (key === "path" && attributeValue.startsWith("/")) {
            path = attributeValue;
          } else if (key === "max-age" && Number(attributeValue) <= 0) {
            expired = true;
          } else if (key === "expires" && Date.parse(attributeValue) <= Date.now()) {
            expired = true;
          }
        }
        const id = `${name}|${path}`;
        if (expired) {
          cookies.delete(id);
        } else {
          cookies.set(id, { name, path, value });
        }
      }
    },
    header(requestUrl) {
      const requestPath = new URL(requestUrl).pathname;
      return [...cookies.values()]
        .filter((cookie) => pathMatches(cookie.path, requestPath))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    },
  };
}

/** 不自动跟随重定向：测试要看清每一步跳到了哪里。 */
export async function getWithCookies(url: string, jar: CookieJar): Promise<Response> {
  const response = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(url) } });
  jar.absorb(response, url);
  return response;
}

export async function postFormWithCookies(
  url: string,
  fields: Record<string, string>,
  jar: CookieJar,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: jar.header(url),
    },
    body: new URLSearchParams(fields).toString(),
  });
  jar.absorb(response, url);
  return response;
}

/** 取 Keycloak 登录页里表单的提交地址和隐藏字段。 */
export function parseLoginForm(html: string): { action: string; fields: Record<string, string> } {
  const openTag = html.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/)?.[0];
  const action = openTag?.match(/\baction="([^"]+)"/)?.[1];
  if (!openTag || !action) {
    throw new Error("没有在 Keycloak 的登录页里找到登录表单");
  }
  const start = html.indexOf(openTag);
  const end = html.indexOf("</form>", start);
  const formHtml = html.slice(start, end === -1 ? undefined : end);
  const fields: Record<string, string> = {};
  for (const input of formHtml.matchAll(/<input\b[^>]*>/g)) {
    const tag = input[0];
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    const isHidden = /\btype="hidden"/.test(tag) || !/\btype=/.test(tag);
    // 只带隐藏字段；用户名和口令由测试自己填。
    if (name && isHidden) {
      fields[name] = tag.match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    }
  }
  return { action: action.replaceAll("&amp;", "&"), fields };
}
