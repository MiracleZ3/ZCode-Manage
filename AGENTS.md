## 项目定位

- 本仓库是 ZCode-EE（ZCode 企业版）的管控平面：管人和设备、模型和密钥、策略和安全、用量、审计、版本和扩展。它随 ZCode-EE 客户端一起完全离线、私有化交付。
- 动手前先读 `docs/enterprise-backend-features-and-language.md`（方案）和 `docs/development-kickoff.md`（启动计划与执行记录）。
- 企业版客户端在 fork 仓库 `ZCode-EE` 的 `ZCode-EE-GLM` 分支。本仓库 `packages/contracts` 是两端接口定义的唯一来源，fork 里的副本由脚本同步，不手改。

## 核心原则

- 新增或修改行为前，先更新 `specs/` 下对应规格，目录不存在时按需创建。先明确规则、状态所有者、接口和验收场景，再实现代码。
- 写法与 ZCode 服务端保持一致，见下文“代码写法”。
- 一份状态只有一个所有者，写路径唯一。明确接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 修复 bug 时用中文注释说明原因和修复依据；发现设计缺陷先与用户对齐，不不断加兜底分支。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。
- 提交说明用 Conventional Commits，正文用中文。提交和推送只在用户要求时做；一次任务里的多处改动按用户意愿合并提交。

## 命令与仓库结构

Node.js 24，pnpm 版本以 `package.json` 的 `packageManager` 为准。以下命令从仓库根目录执行。

| 用途       | 命令                                                 |
| ---------- | ---------------------------------------------------- |
| 类型检查   | `pnpm typecheck`                                     |
| Lint       | `pnpm lint` / `pnpm lint:fix`                        |
| 格式       | `pnpm fmt` / `pnpm fmt:check`                        |
| 测试       | `pnpm test`，可跟文件路径只跑一部分                  |
| 构建       | `pnpm build`                                         |
| 本地开发   | `pnpm dev`，同时启动 `manage-api` 与 `model-gateway` |
| 推送前检查 | `pnpm verify:pre-push`                               |

- `apps/manage-api`：控制面（身份与席位、设备与分发、策略、模型与密钥、审计、运营分析）。
- `apps/model-gateway`：数据面（验令牌、配额与限流、转发到私有云、计量）。
- `apps/console`：管理控制台 Web，Step 1 加入。
- `packages/contracts`：接口的 zod 定义与 OpenAPI 的来源，不依赖其他内部包。
- `packages/shared`：日志、环境变量读取、每个服务的 Hono 骨架。
- `deploy/`：部署编排；`docs/`：方案与执行记录；`specs/`：各模块规格。

## 代码写法

与 ZCode 服务端（fork 的 `packages/server`）用同一种写法，两个仓库切换时只记一套。

1. **工厂函数，不用装饰器和依赖注入容器。** 入口 `entry-http.ts` 的 `main()` 负责装配：读配置、建 logger、`createXxx()`、启动。服务对象用 `createXxxService(deps)` 创建，依赖通过参数传入。
2. **选项对象。** 可选项在接口里标可选；构造对象时用条件展开，不传出值为 `undefined` 的属性。
3. **环境变量。** 统一经 `readTrimmedEnv` 读取（已 trim，空串按未设置处理），前缀 `ZM_`；启动时用 zod 校验，非法即拒绝启动，不读 `.env` 文件。
4. **在边界上 `parse`。** 请求、响应、配置、持久化数据在进出时用 contracts 里的 schema 做运行时校验，未校验的 `unknown` 不往业务层传。
5. **为了可测试而注入。** 依赖做成带默认值的参数（如 `loadConfig({ env })`、`createLogger({ sink, now })`），测试注入替身，不 mock 全局。
6. **模块与导入。** ESM，相对导入带 `.js` 后缀；跨包只走包的公开入口（`@zm/*`），不深入别的包的内部路径；类型导入用 `import type`。
7. **构建期常量。** 需要在构建时固定的值走 `define` 注入（见各应用的 `tsup.config.ts`），测试态由 `vitest.config.ts` 注入，运行时不去读。
8. **注释。** 中文，只解释“为什么”和不显然的约束，不逐行翻译代码；修复处写明原因和依据。
9. **命名。** 文件 camelCase，入口 kebab-case；函数 `createXxx`、`resolveXxx`、`isXxx`；选项与配置接口以 `Options`、`Config` 结尾。
10. **测试放在包内的 `test/` 目录**，与 `src` 分开，不进入编译范围；文件名 `*.test.ts`，断言写行为，不写实现细节。

## 验证

- 改动后必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不把已有的失败写成通过。
- 新行为先写会失败的测试。契约（`packages/contracts`）改动后，两端都要有对应的契约测试。
- 涉及数据库、Redis 的行为用集成测试验证，不用纯 mock 代替。
- 异步文件和网络 IO；禁止在业务模块里直接调用 `window`、Electron 或具体运行时的内部实现。

## 日志

- 使用 `createLogger(scope)`，第一个参数是 trace ID（通常是请求 ID），没有上下文传 `undefined`。
- `debug` 用于协议原始数据、流式片段和逐条事件等高频诊断，production 默认不输出；`info` 用于进程与会话生命周期、一次性初始化；`warn` 用于可恢复异常；`error` 用于不可恢复错误。
- 时间戳是 ISO 8601 UTC，与 ZCode 的本地时间写法不同，原因是容器日志要跨时区聚合。

## 安全与凭据

- 不在日志、示例、测试夹具或提交中写入凭据、真实用户数据和内部服务地址；需要占位时用明显的假值。
- 对外错误只返回稳定的 `code`、简短 `message` 和 `requestId`，内部细节只进日志。
- 接口里的请求 ID、路径、查询参数都来自不可信输入：写入日志前校验，路径拼接前校验范围。
