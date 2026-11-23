import { useEffect, useState, type ReactNode } from "react";
import type { User } from "oidc-client-ts";
import { displayName, getUserManager, signIn, signOut } from "./auth.js";
import { describeError } from "./errors.js";
import { UsageTable } from "./UsageTable.js";

/**
 * 页面启动时的状态，由 main.tsx 在渲染之前算好。
 * broken 表示连登录状态都没法判断，例如缺少部署期配置、颁发者连不上。
 */
export type Startup =
  | { view: "signed-out"; notice: string | null }
  | { view: "signed-in"; user: User }
  | { view: "login-failed"; message: string }
  | { view: "broken"; message: string };

/** 次要按钮。 */
const BUTTON_STYLE =
  "rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800";

/** 主要按钮。 */
const PRIMARY_BUTTON =
  "w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`mt-4 rounded-lg p-3 text-sm ${toneClass}`}
    >
      {children}
    </p>
  );
}

export function App({ startup }: { startup: Startup }) {
  const [session, setSession] = useState<Startup>(startup);
  // 正在跳转：按钮点了之后页面马上会被带走，期间不让再点第二次。
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const events = getUserManager().events;
    const unsubscribe: (() => void)[] = [
      events.addUserSignedOut(() => setSession({ view: "signed-out", notice: "已退出登录。" })),
      // 续期没赶上、访问令牌已经过期：留在已登录的界面上没有意义。
      events.addAccessTokenExpired(() =>
        setSession({ view: "signed-out", notice: "登录已过期，请重新登录。" }),
      ),
    ];
    return () => {
      for (const off of unsubscribe) {
        off();
      }
    };
  }, []);

  /** 跳转成功时页面会被带走，不会再回到这里；只有跳转没发起来才会走到 catch。 */
  const navigate = async (go: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await go();
    } catch (error) {
      setActionError(describeError(error));
      setBusy(false);
    }
  };

  if (session.view === "broken") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Notice tone="error">控制台启动失败：{session.message}</Notice>
      </main>
    );
  }

  if (session.view === "signed-in") {
    return (
      <div className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4">
            <div className="mr-auto">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">ZCode-EE</p>
              <h1 className="text-lg font-semibold tracking-tight">管理控制台</h1>
            </div>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {displayName(session.user)}
            </span>
            <button
              type="button"
              onClick={() => navigate(signOut)}
              disabled={busy}
              className={BUTTON_STYLE}
            >
              退出
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">
          {actionError && <Notice tone="error">{actionError}</Notice>}
          <UsageTable />
        </main>
      </div>
    );
  }

  // 走到这里只剩未登录与登录失败两种。
  let message: ReactNode = null;
  if (session.view === "login-failed") {
    message = <Notice tone="error">登录没有完成：{session.message}</Notice>;
  } else if (session.notice) {
    message = <Notice tone="info">{session.notice}</Notice>;
  }
  if (actionError) {
    message = <Notice tone="error">{actionError}</Notice>;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">ZCode-EE</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">管理控制台</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          用你所在组织的账号登录，查看模型用量明细。
        </p>
        {message}
        <button
          type="button"
          onClick={() => navigate(signIn)}
          disabled={busy}
          className={`${PRIMARY_BUTTON} mt-6`}
        >
          {busy ? "正在跳转…" : session.view === "login-failed" ? "重新登录" : "登录"}
        </button>
      </section>
    </main>
  );
}
