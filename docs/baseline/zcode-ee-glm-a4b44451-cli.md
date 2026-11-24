# 上游基线：ZCode v4.0.0（`a4b44451`）的 Agent CLI 工作区

> **对象**：fork `ZCode-EE` 的 `ZCode-EE-GLM` 分支在 `a4b44451` 时的状态，不含任何企业版改动。与[根目录那份基线](zcode-ee-glm-a4b44451.md)互补：那份覆盖仓库根的检查，这份覆盖 `apps/zcode-cli`。
> **时间与设备**：2026-11-24，Apple M5，macOS 27.2，Node 24.14.0，pnpm 10.33.2。
> **用途**：`apps/zcode-cli` 是一个独立的工作区，有自己的测试、类型检查和 Lint 入口，仓库根的命令不覆盖它。改 Agent 运行时之后对照这份基线，区分“上游本来就有”和“我们引入的”。

## 一、为什么要单独存一份

企业版的多数改造点（T1、T3、T4、T5、T6、T7）落在 `apps/zcode-cli` 里。之前的基线只记录了仓库根的三项检查，CLI 工作区的测试、类型检查和 Lint 没有存档过，第一次在 CLI 里动手时才知道它带着一批与改动无关的失败。

## 二、怎么跑

以下都在 fork 源码目录执行，先切到钉定的 Node：

```sh
export PATH="$HOME/.local/opt/node-v24.14.0/node-v24.14.0-darwin-arm64/bin:$PATH"
```

| 用途 | 命令 |
| --- | --- |
| CLI 类型检查 | `cd apps/zcode-cli && ../../node_modules/.bin/turbo run typecheck` |
| CLI Lint | `pnpm --dir apps/zcode-cli lint` |
| 某个包的测试 | `pnpm --dir apps/zcode-cli/packages/<包名> exec vitest run tests` |
| cli 包的测试 | `pnpm --dir apps/zcode-cli/packages/cli test` |
| 单个测试文件 | `pnpm --dir apps/zcode-cli/packages/<包名> exec vitest run tests/<文件>.test.ts` |

- **类型检查只能用根目录的 turbo。** 仓库声明的入口 `pnpm --dir apps/zcode-cli typecheck` 在本机跑不起来，报 `turbo: command not found`：turbo 装在仓库根目录，`apps/zcode-cli` 这个嵌套工作区里没有装。原因是依赖安装状态，没有改动过它。
- **不要直接在包里跑 `tsc --noEmit`** 来代替类型检查。多数包的类型声明指向 `dist`，依赖没构建时会报几十个“找不到模块”，看起来像错误，其实只说明依赖没构建。
- **改了 contracts 之后要先构建它**：`pnpm --filter @zcode/contracts build`。其余包经 `dist` 引用它，不会读到源码里的改动。adapters、core、bootstrap 同理，依次构建。
- 测试输出默认不是 TAP 格式。要用 grep 读结果时加 `--test-reporter=tap`，否则只能看到 `✔`、`✖` 行。
- **跑完 cli 包的整组测试，`apps/zcode-cli/packages/adapters/backup/` 下会多出几个会话库备份目录。** 这是上游测试留下的，那个位置没有被 git 忽略，`git add -A` 会把它提交进去。提交之前先看一眼，确认是测试残留后删掉。

## 三、结果

| 检查 | 结果 |
| --- | --- |
| CLI 类型检查 | 34 个任务全部通过 |
| CLI Lint | 0 个错误，87 个警告，另有 3 条针对上游文件的行数诊断 |
| contracts 测试 | 44 个文件，345 个通过，0 个失败 |
| adapters 测试 | 214 个文件：212 个通过，2 个失败；失败的用例 17 个 |
| core 测试 | 349 个文件，5819 个通过，21 个跳过，整包运行时 0 个失败 |
| bootstrap 测试 | 283 个文件：279 个通过，2 个失败，2 个跳过。用例 3874 个通过，2 个失败，9 个跳过 |
| cli 包测试 | 553 个用例：547 个通过，6 个失败 |

### 上游本来就有的失败

**稳定失败**

| 包 | 文件 | 失败的用例 | 现象 |
| --- | --- | --- | --- |
| adapters | `tests/mcp.test.ts` | 16 | MCP 的 OAuth 授权用例等不到授权地址，或者状态快照不收敛，多为超时 |
| adapters | `tests/preinstalled-tools.test.ts` | 1 | 断言依赖本机的预装工具目录 |
| bootstrap | `tests/dynamic-mcp-config.test.ts` | 1 | 两条路径得到的 MCP 清单不同，一边多出官方的 `image-search` |
| cli | SEA（单文件可执行程序）的工具缓存相关用例，所在文件没有逐个确认 | 6 | 提取、复用、修复工具缓存；用例名里有 “extracts target tools …” “SEA tools” |

adapters 那次运行还带着一个未处理的拒绝（`McpTimeoutError`）。

**间歇失败**

| 包 | 文件 | 实测 |
| --- | --- | --- |
| core | `tests/subagent-cold-resume.test.ts` | 未改动时单独运行 10 次失败 3 次；带着 T1、T3 改动 10 次失败 2 次 |
| bootstrap | `tests/session-control/standalone-tui-approval.e2e.test.ts` | 未改动时整包运行通过、单独运行 3 次失败 3 次；带着 T1、T3 改动的整包运行里失败过 |
| bootstrap | `tests/bundled-plugins-resilience.test.ts` | 未改动的整包运行失败 1 个；带着 T1、T3 改动的整包运行通过 |

所以 bootstrap 整包的“失败文件是哪两个”每次运行可能不一样。判断一个失败是不是自己带来的，不能只看一次运行：**把改动收起来，在未改动的代码上用同样的命令跑同一个文件**。

## 四、这份基线没覆盖的

- 其余 CLI 包的测试没有跑：tui、i18n、provider、telemetry 等约三十个包只有类型检查和 Lint 的结果。
- adapters 的总用例数没有记下来，只有文件数和失败数。
- 间歇失败的触发条件没有查，只知道与负载有关。
- 全部只在 macOS 上跑过。

## 五、对照记录

2026-11-24 做完 T1、T3（受管策略）之后的数字，改动都在 `apps/zcode-cli` 里：

| 检查 | 基线 | 带这次改动 |
| --- | --- | --- |
| CLI 类型检查 | 34 个任务通过 | 34 个任务通过 |
| CLI Lint | 0 个错误，87 个警告 | 0 个错误，87 个警告 |
| contracts 测试 | 345 个通过 | 352 个通过，多出的 7 个是新增的 |
| adapters 测试 | 214 个文件，212 通过，2 失败 | 215 个文件，213 通过，2 失败；失败的是同样的两个文件，多出的一个文件通过 |
| core 测试 | 整包运行 0 个失败 | 整包运行 1 个文件失败，是上表间歇失败的那个 |
| bootstrap 测试 | 2 个文件失败 | 2 个文件失败；与基线相同的只有 `dynamic-mcp-config`，另一个是上表间歇失败的 |
| cli 包测试 | 547 通过，6 失败 | 550 通过，6 失败；失败的与基线是同样的 6 个 |

这次改动的每个新测试文件，以及它所在包里被改到的既有测试文件，都在改动恢复之后单独重跑过并全部通过。
