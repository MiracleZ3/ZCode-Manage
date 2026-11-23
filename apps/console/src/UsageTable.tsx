import { useEffect, useState, type ReactNode } from "react";
import type { UsageErrorKind, UsageEvent, UsageSource } from "@zm/contracts";
import { signIn } from "./auth.js";
import { ApiError, fetchUsagePage } from "./api.js";
import { describeError } from "./errors.js";

/** 第一页的状态。unauthorized 为 true 时，界面给出重新登录的入口而不是重试。 */
type FirstPage =
  | { status: "loading" }
  | { status: "done" }
  | { status: "failed"; message: string; unauthorized: boolean };

interface TableState {
  firstPage: FirstPage;
  items: UsageEvent[];
  /** 为 null 表示后面没有更多了。 */
  nextCursor: string | null;
  loadingMore: boolean;
  /** 加载下一页失败的原因。没失败过，或已经恢复时为 null。 */
  loadMoreError: string | null;
}

const INITIAL_STATE: TableState = {
  firstPage: { status: "loading" },
  items: [],
  nextCursor: null,
  loadingMore: false,
  loadMoreError: null,
};

/** 本文件里几个次要按钮共用的样式。外边距各用各的，不写在这里。 */
const BUTTON_STYLE =
  "rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800";

const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" });

const ERROR_KIND_LABEL: Record<UsageErrorKind, string> = {
  client_error: "请求被拒绝",
  upstream_error: "上游出错",
  network_error: "连不上上游",
};

const USAGE_SOURCE_LABEL: Record<UsageSource, string | null> = {
  upstream: null,
  estimated: "token 数是估算的",
  missing: "上游没有给出用量",
};

function formatTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : timeFormat.format(date);
}

/** 一行末尾的说明：失败的调用写明原因；token 数不可信时写明原因。两者都有时都写。 */
function describe(event: UsageEvent): string {
  const notes: string[] = [];
  if (event.errorKind) {
    notes.push(ERROR_KIND_LABEL[event.errorKind]);
  }
  const source = USAGE_SOURCE_LABEL[event.usageSource];
  if (source) {
    notes.push(source);
  }
  return notes.join("；") || "—";
}

function formatTokens(event: UsageEvent): string {
  const { inputTokens, outputTokens, totalTokens } = event;
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return "—";
  }
  return `${inputTokens} / ${outputTokens} / ${totalTokens}`;
}

function statusTone(code: number): string {
  if (code < 300) {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (code < 500) {
    return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300";
}

function failure(error: unknown): FirstPage {
  return {
    status: "failed",
    message: describeError(error),
    unauthorized: error instanceof ApiError && error.status === 401,
  };
}

export function UsageTable() {
  const [state, setState] = useState<TableState>(INITIAL_STATE);
  // 重新加载第一页时把它加一，让下面的副作用再执行一次。
  const [attempt, setAttempt] = useState(0);
  // 发起登录本身失败时的原因（例如颁发者连不上）。
  const [signInError, setSignInError] = useState<string | null>(null);

  // 只负责第一页，所以只在这一刻触发：令牌每次请求时现取，见 api.ts。
  useEffect(() => {
    let cancelled = false;
    fetchUsagePage().then(
      (page) => {
        if (!cancelled) {
          setState({
            firstPage: { status: "done" },
            items: page.items,
            nextCursor: page.nextCursor,
            loadingMore: false,
            loadMoreError: null,
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ ...INITIAL_STATE, firstPage: failure(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const loadMore = async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore) {
      return;
    }
    setState((current) => ({ ...current, loadingMore: true, loadMoreError: null }));
    try {
      const page = await fetchUsagePage(cursor);
      setState((current) => ({
        ...current,
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
      }));
    } catch (error) {
      // 已经加载的行留着，只说明这一页没取到。
      setState((current) => ({
        ...current,
        loadingMore: false,
        loadMoreError: describeError(error),
      }));
    }
  };

  // 令牌失效后不能只是回到首页：内存里那个失效的用户还在，回去只会再被拒绝一次。
  // 要真正重新走一遍登录。
  const reSignIn = () => {
    setSignInError(null);
    signIn().catch((error: unknown) => setSignInError(describeError(error)));
  };

  let body: ReactNode;
  if (state.firstPage.status === "loading") {
    body = (
      <p className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">正在加载…</p>
    );
  } else if (state.firstPage.status === "failed") {
    body = (
      <div className="px-6 py-10 text-center">
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {state.firstPage.message}
        </p>
        {signInError && (
          <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
            发起登录没有成功：{signInError}
          </p>
        )}
        {state.firstPage.unauthorized ? (
          <button type="button" onClick={reSignIn} className={`${BUTTON_STYLE} mt-4`}>
            重新登录
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
            className={`${BUTTON_STYLE} mt-4`}
          >
            重试
          </button>
        )}
      </div>
    );
  } else if (state.items.length === 0) {
    body = (
      <p className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
        还没有用量记录。
      </p>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead className="text-xs text-zinc-500 dark:text-zinc-400">
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th scope="col" className="px-6 py-3 font-medium">
                时间
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                归属
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                模型
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                状态
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                token（输入 / 输出 / 合计）
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                耗时
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                说明
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {state.items.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap px-6 py-3 tabular-nums">
                  {formatTime(event.occurredAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="font-medium">{event.subjectName || event.subjectId}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {event.subjectType === "user" ? "用户" : "服务账号"} · {event.clientId}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <div>{event.model}</div>
                  {event.upstreamModel !== event.model && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      上游名 {event.upstreamModel}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <span
                    className={`rounded-md px-2 py-0.5 font-medium ${statusTone(event.statusCode)}`}
                  >
                    {event.statusCode}
                  </span>
                  <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                    {event.stream ? "流式" : "非流式"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatTokens(event)}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                  {event.durationMs === null ? "—" : `${event.durationMs} 毫秒`}
                </td>
                <td className="px-6 py-3 text-zinc-600 dark:text-zinc-400">{describe(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const finished = state.firstPage.status === "done" && state.nextCursor === null;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h2 className="text-base font-semibold">模型用量</h2>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">最近的调用排在前面。</p>
      </div>
      {body}
      {state.firstPage.status === "done" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            已加载 {state.items.length} 条{finished ? "，没有更多了" : ""}
          </p>
          {state.loadMoreError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              下一页没有加载成功：{state.loadMoreError}
            </p>
          )}
          {!finished && (
            <button
              type="button"
              onClick={loadMore}
              disabled={state.loadingMore}
              className={BUTTON_STYLE}
            >
              {state.loadingMore ? "加载中…" : "加载更多"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
