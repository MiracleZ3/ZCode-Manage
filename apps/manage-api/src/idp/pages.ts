/**
 * 直接给人看的两个极简页面：退出登录的确认页，以及出错时的提示页。
 *
 * 只输出自带的 HTML 与内联样式，不引用任何外部字体、脚本或样式。库自带的同类页面会去加载
 * 外部字体，而交付环境是完全离线的，所以不能用。
 * 放进页面的文字一律转义：主机名和错误描述都可能追溯到请求的内容。
 */

/** 这两个页面的内容安全策略。除了内联样式之外什么都不允许，表单只能提交给本站。 */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
         box-sizing: border-box; background: #fafafa; color: #18181b;
         font: 16px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { box-sizing: border-box; width: min(28rem, 100%); padding: 2rem; background: #fff;
         border: 1px solid #e4e4e7; border-radius: 1rem; }
  h1 { margin: 0 0 .75rem; font-size: 1.25rem; font-weight: 600; }
  p { margin: 0 0 1.5rem; color: #52525b; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }
  form { display: flex; flex-wrap: wrap; gap: .75rem; margin: 0; }
  button { padding: .5rem 1rem; border: 1px solid #d4d4d8; border-radius: .5rem; background: #fff;
           color: inherit; font: inherit; cursor: pointer; }
  button[name="logout"] { background: #18181b; border-color: #18181b; color: #fff; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #f4f4f5; }
    main { background: #18181b; border-color: #3f3f46; }
    p { color: #a1a1aa; }
    button { background: #18181b; border-color: #3f3f46; color: #f4f4f5; }
    button[name="logout"] { background: #f4f4f5; border-color: #f4f4f5; color: #18181b; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * 退出登录的确认页。使用者在应用里点了“退出”，到这里再确认一次：
 * 真正结束会话的是随后的一次表单提交，库靠它防止第三方页面把人悄悄登出。
 *
 * form 是库生成的隐藏表单，里面有一次性令牌，**原样嵌入**，不转义。
 * 库给这个表单写死的 id 是 op.logoutForm，下面两个按钮都靠它关联到表单上。
 */
export function logoutConfirmationPage(input: { host: string; form: string }): string {
  return page(
    "确认退出登录",
    `<h1>确认退出登录</h1>
<p>确定要退出在 ${escapeHtml(input.host)} 上的登录吗？</p>
${input.form}
<button autofocus type="submit" form="op.logoutForm" value="yes" name="logout">退出登录</button>
<button type="submit" form="op.logoutForm">留在登录状态</button>`,
  );
}

/** 出错时的提示页：给出错误码与库附带的说明。homeUrl 是让使用者重新开始的入口。 */
export function errorPage(input: { code: string; description?: string; homeUrl: string }): string {
  const description = input.description ? `<br><code>${escapeHtml(input.description)}</code>` : "";
  return page(
    "请求没有完成",
    `<h1>请求没有完成</h1>
<p>错误码：<code>${escapeHtml(input.code)}</code>${description}</p>
<p><a href="${escapeHtml(input.homeUrl)}">回到控制台重新开始</a></p>`,
  );
}
