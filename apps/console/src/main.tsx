import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type Startup } from "./App.js";
import { CALLBACK_PATH, currentUser, finishLogin } from "./auth.js";
import { describeError } from "./errors.js";
import "./index.css";

async function readStartup(): Promise<Startup> {
  if (window.location.pathname !== CALLBACK_PATH) {
    const user = await currentUser();
    return user ? { view: "signed-in", user } : { view: "signed-out", notice: null };
  }
  try {
    return { view: "signed-in", user: await finishLogin() };
  } catch (error) {
    // 失败时地址栏里同样留着已经作废的授权码，也把它换掉。
    window.history.replaceState(null, "", "/");
    return { view: "login-failed", message: describeError(error) };
  }
}

// 登录回调在渲染之前处理，不放进组件的生命周期里：回调地址里的授权码用过即废，
// 整个页面只能处理一次，而 React 的严格模式在开发时会故意把副作用执行两遍。
let startup: Startup;
try {
  startup = await readStartup();
} catch (error) {
  startup = { view: "broken", message: describeError(error) };
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html 里缺少 #root");
}

createRoot(container).render(
  <StrictMode>
    <App startup={startup} />
  </StrictMode>,
);
