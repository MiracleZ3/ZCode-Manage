import { usageEventPageSchema, type UsageEventPage } from "@zm/contracts";
import { getUserManager } from "./auth.js";

const PAGE_SIZE = 50;

/** 调用管理接口失败。带着状态码，界面据此区分“登录失效”与其他失败。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 取用量明细的一页。cursor 省略时取第一页；下一页的游标取自上一页的 nextCursor。 */
export async function fetchUsagePage(cursor?: string): Promise<UsageEventPage> {
  // 每次请求时现取令牌：访问令牌会被自动续期，调用方手里不必（也不该）留着一份旧的。
  const user = await getUserManager().getUser();
  if (!user || user.expired) {
    throw new ApiError(401, "登录已失效，请重新登录。");
  }

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) {
    query.set("cursor", cursor);
  }
  const response = await fetch(`/em/v1/usage/events?${query}`, {
    headers: { authorization: `Bearer ${user.access_token}` },
  });
  if (!response.ok) {
    throw new ApiError(response.status, describeStatus(response.status));
  }

  const parsed = usageEventPageSchema.safeParse(await response.json());
  if (!parsed.success) {
    // 与契约对不上说明管理端与控制台不是同一个版本，是部署问题。把它报出来，不当作“没有数据”糊弄过去。
    throw new ApiError(
      response.status,
      "用量明细的格式与契约不符，管理端与控制台的版本可能不一致。",
    );
  }
  return parsed.data;
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "登录已失效，请重新登录。";
    case 403:
      return "当前账号没有查看用量的权限。";
    default:
      return `请求失败（HTTP ${status}）。`;
  }
}
