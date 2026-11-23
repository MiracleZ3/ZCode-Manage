import { getRequestListener } from "@hono/node-server";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Logger } from "./logger.js";

/** 取请求路径用的占位基址；pathname 之外的成员不被使用。 */
const PATHNAME_BASE = "http://localhost";

/** Hono 的 fetch 有时同步返回响应，所以允许两种返回方式。 */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** 在 Hono 之前接管某些路径的处理函数，直接使用 Node 原生的请求与响应。 */
export type InterceptHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface HttpServerOptions {
  fetch: FetchHandler;
  hostname: string;
  port: number;
  logger: Logger;
  /**
   * 需要在 Hono 之前处理一部分路径时传入，例如 OIDC 端点和登录交互。
   * 返回 undefined 表示这个路径交给 Hono。
   */
  intercept?: (pathname: string) => InterceptHandler | undefined;
  /** 是否安装 SIGTERM 与 SIGINT 的退出处理。默认安装；测试里关掉。 */
  handleSignals?: boolean;
  /** 关闭时最多等在途请求多久，超过后强制断开。 */
  shutdownTimeoutMs?: number;
  /**
   * 服务停止监听之后的收尾，例如等后台写入落库、关闭数据库连接池。
   * 收到退出信号时它在连接全部结束之后、进程退出之前执行。
   */
  onClosed?: () => Promise<void>;
}

export interface HttpServerHandle {
  server: Server;
  port: number;
  /** 等在途请求结束或超时后才返回。 */
  close: () => Promise<void>;
}

/**
 * 启动一个 HTTP 服务。只允许一个处理链：先看有没有接管某条路径的处理函数，没有再交给 Hono。
 * 这样接管路径的处理器直接写原生响应时，不会与 Hono 适配器的响应互相覆盖。
 */
export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const honoListener = getRequestListener(options.fetch);
  const intercept = options.intercept;
  const logger = options.logger;

  const listener: RequestListener = (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", PATHNAME_BASE).pathname;
    } catch {
      // URL 解析失败时交给 Hono，让它按自己的规则返回 400。
    }
    const handler = intercept?.(pathname);
    if (handler) {
      void Promise.resolve()
        .then(() => handler(req, res))
        .catch((error: unknown) => {
          logger.error(undefined, "intercept handler failed", error);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          }
          res.end("Internal Server Error");
        });
      return;
    }
    return honoListener(req, res);
  };

  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  // 监听任意地址时打印 localhost，打印出来的地址才可以直接访问。
  const hostnameForLog =
    options.hostname === "0.0.0.0" || options.hostname === "::" ? "localhost" : options.hostname;
  logger.info(undefined, `listening on http://${hostnameForLog}:${port}`);

  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;

  function close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      // 在途请求给足时间，超时后强制断开，免得进程退出被一个慢请求卡住。
      const forceTimer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
      forceTimer.unref();
      server.close(() => {
        clearInterval(sweepTimer);
        clearTimeout(forceTimer);
        resolve();
      });
      // 调用 closeIdleConnections 只能收掉“此刻”空闲的连接。正在处理请求的连接在响应结束后
      // 会变成长连接挂着，不会自己断；所以关闭期间定期清扫，让刚空闲的连接也被收掉。
      const sweepTimer = setInterval(() => server.closeIdleConnections(), 50);
      sweepTimer.unref();
      server.closeIdleConnections();
    });
  }

  if (options.handleSignals ?? true) {
    // 容器停止时编排先发 SIGTERM。等在途请求结束、收尾做完再退出，不中断正在进行的响应，
    // 也不丢还没落库的后台写入。
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        logger.info(undefined, `received ${signal}, shutting down`);
        void close()
          .then(() => options.onClosed?.())
          .then(
            () => process.exit(0),
            (error: unknown) => {
              logger.error(undefined, "shutdown failed", error);
              process.exit(1);
            },
          );
      });
    }
  }

  return { server, port, close };
}

/**
 * 监听一个临时端口的服务，给集成测试用。不用时直接关掉，不碰任何信号处理。
 */
export async function listenForTest(
  options: Omit<HttpServerOptions, "handleSignals" | "port" | "hostname">,
) {
  return startHttpServer({ ...options, hostname: "127.0.0.1", port: 0, handleSignals: false });
}
