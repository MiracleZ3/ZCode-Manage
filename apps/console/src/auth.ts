import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { consoleConfig } from "./config.js";

/** 颁发者登录完成后把浏览器带回的路径。 */
export const CALLBACK_PATH = "/callback";

let instance: UserManager | undefined;

/**
 * 管理登录状态的唯一入口。第一次用到时才创建：缺少部署期配置时抛出的错误
 * 能被启动流程接住并显示出来；如果在模块加载时就创建，使用者只会看到一张白页。
 */
export function getUserManager(): UserManager {
  if (instance) {
    return instance;
  }
  const origin = window.location.origin;
  instance = new UserManager({
    // 颁发者就是页面自己的来源：管理接口与 OIDC 端点都经代理挂在同一个地址下。
    // 发现文档里的端点都是绝对地址，所以这个地址必须与页面同源，否则请求会被浏览器拦掉。
    authority: origin,
    client_id: consoleConfig.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    // 控制台只查看用量，不要调用模型的范围。
    scope: "openid profile offline_access usage:read",
    response_type: "code",
    // 申请 offline_access 的授权请求必须带 prompt=consent，这是 OpenID Connect 的规定。
    // 不带的话颁发者不报错，只是悄悄去掉这个范围：拿不到刷新令牌，15 分钟后就得重新登录。
    // 管控平面的“同意”一步由程序自动批准，使用者看不到任何多余的页面。
    prompt: "consent",
    // 显示名取自身份令牌，不必查用户信息端点。本期所有访问令牌都签给管控平面的 api 资源、带受众，
    // 带受众的令牌按规范不能用于用户信息端点（那边会拒绝），库于是在身份令牌里带上经 profile 范围
    // 获批的声明。若这里拿不到 name，先去看颁发者的 claims 配置有没有登记它。
    loadUserInfo: false,
    // 令牌只放在内存里，不写 localStorage：那里的内容，任何一段被注入的脚本都读得到。
    // 代价是刷新页面后要重新点一次登录。
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // 访问令牌 15 分钟过期。到期前自动用刷新令牌换新的。
    automaticSilentRenew: true,
  });
  return instance;
}

/** 发起登录：整页跳转到颁发者。 */
export function signIn(): Promise<void> {
  return getUserManager().signinRedirect();
}

/** 退出：让颁发者结束会话后回到首页。 */
export function signOut(): Promise<void> {
  return getUserManager().signoutRedirect();
}

/**
 * 处理登录回调。回调地址里的授权码用过即废，所以整个页面生命周期里只能调用它一次。
 */
export async function finishLogin(): Promise<User> {
  const user = await getUserManager().signinRedirectCallback();
  // 地址栏里还挂着授权码与状态参数，换掉它们，刷新时才不会再拿同一个码去试。
  window.history.replaceState(null, "", "/");
  return user;
}

/** 当前保存的用户；这个页面里没有登录过时返回 null。访问令牌是否过期由调用方检查。 */
export async function currentUser(): Promise<User | null> {
  return getUserManager().getUser();
}

/** 使用者看到的名字：显示名，没有时退回到主体标识。 */
export function displayName(user: User): string {
  const name = user.profile.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : user.profile.sub;
}
