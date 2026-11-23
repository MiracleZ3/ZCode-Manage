import { describe, expect, it } from "vitest";
import { errorPage, logoutConfirmationPage } from "../src/idp/pages.js";

describe("给人看的页面", () => {
  it("不引用任何外部资源：没有脚本、外链样式或 @import；绝对地址只可能来自库给的表单", () => {
    const logout = logoutConfirmationPage({ host: "zm.example.test", form: FORM });
    const error = errorPage({ code: "invalid_request", homeUrl: "/" });

    for (const html of [logout, error]) {
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/@import|<link\b/i);
      // 表单由库生成、原样嵌入；扣掉它之后，页面自身不应该有任何绝对地址。
      expect(html.replaceAll(FORM, "")).not.toMatch(/https?:\/\//);
    }
  });

  it("来自请求的文字被转义，塞不进标签或脚本", () => {
    const html = logoutConfirmationPage({ host: `<img src=x onerror="alert(1)">`, form: FORM });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

    const failed = errorPage({
      code: "server_error",
      description: "<script>alert(document.domain)</script>",
      homeUrl: "/",
    });
    expect(failed).not.toContain("<script>alert");
    expect(failed).toContain("&lt;script&gt;alert(document.domain)&lt;/script&gt;");
  });

  it("库生成的隐藏表单原样嵌入，不转义：里面有一次性令牌，转了 HTML 实体就对不上了", () => {
    const html = logoutConfirmationPage({ host: "zm.example.test", form: FORM });
    expect(html).toContain(FORM);
  });

  it("退出确认页的两个按钮都挂在库的表单上，其中带 logout 字段的那个才是确认", () => {
    const html = logoutConfirmationPage({ host: "zm.example.test", form: FORM });
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('form="op.logoutForm"');
      expect(button).toContain('type="submit"');
    }
    expect(buttons.filter((button) => button.includes('name="logout"'))).toHaveLength(1);
  });
});

/**
 * 库生成的表单的形状。表单 id 与字段名是库定下的；action 是指向颁发者自己的绝对地址。
 */
const FORM =
  '<form id="op.logoutForm" method="post" action="https://zm.example.test/connect/logout/confirm"><input type="hidden" name="xsrf" value="secret-token"/></form>';
