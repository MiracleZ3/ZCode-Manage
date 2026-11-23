/**
 * 适配器归一出来的身份。subject 是客户身份系统里的主体标识，稳定且不复用。
 */
export interface Identity {
  subject: string;
  displayName: string;
  email?: string;
}

/**
 * 第一类适配器：把浏览器带到客户身份系统去登录。
 * 客户端只对接管控平面，客户之间的差异全部收在这里。
 */
export interface RedirectAuthAdapter {
  id: string;
  kind: "redirect";
  /**
   * 生成客户身份系统的授权地址。管控平面负责生成 state 并在回调时核对；
   * 适配器要把它原样带上，并自己决定是否使用 PKCE。
   */
  buildAuthorizationUrl(input: { state: string; callbackUrl: string }): Promise<RedirectStart>;
  /**
   * 用客户身份系统回调带来的参数完成登录：换取并校验令牌，取出用户信息。
   * 回调的 state 已由管控平面核对过；这里的 state 再核一次，是适配器自己的职责。
   */
  finishLogin(input: { callbackUrl: URL; state: string; codeVerifier: string }): Promise<Identity>;
}

export interface RedirectStart {
  url: string;
  codeVerifier: string;
}
