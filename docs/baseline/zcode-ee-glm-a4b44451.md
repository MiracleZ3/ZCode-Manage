# 上游基线：ZCode v4.0.0（`a4b44451`）

> **对象**：fork `ZCode-EE` 的 `ZCode-EE-GLM` 分支在 `a4b44451` 时的状态，即官方 `zai-org/ZCode` v4.0.0 的 `main`，不含任何企业版改动。
> **时间与设备**：2026-11-23，Apple M5，macOS 27.2，32 GiB 内存。
> **工具链**：pnpm 10.33.2。第一次用本机默认的 Node v24.10.0；随后在仓库 `mise.toml` 钉定的 Node 24.14.0 下复验， 两遍结果一致，见第六节。
> **用途**：企业分支每次改动后对照这份基线，区分“上游本来就有”和“我们引入的”。

## 一、结论

| 检查     | 命令                    | 结果                                        | 用时  |
| -------- | ----------------------- | ------------------------------------------- | ----- |
| 类型检查 | `pnpm typecheck`        | 通过                                        | 69 秒 |
| Lint     | `pnpm lint`             | 0 个错误，537 个警告                        | 2 秒  |
| 工程测试 | `pnpm test:engineering` | 1157 个通过，25 个跳过，0 个失败            | 77 秒 |

工程测试的数字来自第二次运行。第一次运行有一个失败，原因和处理见第三节，与代码无关。3 个测试文件整体跳过，25 个用例跳过，都是上游自行标注的跳过条件。

`pnpm verify:pre-push` 的整条链也手工跑过一遍，逐项结果见第六节。

## 二、Lint 的 537 个警告

同目录下的 `zcode-ee-glm-a4b44451.lint-warnings.tsv` 是逐条快照，每行四个字段：规则、文件、行号、说明，已排序。共 537 行，涉及 193 个文件。

| 规则                                      | 条数 |
| ----------------------------------------- | ---- |
| `react-hooks(exhaustive-deps)`            | 420  |
| `eslint(no-unused-vars)`                  | 65   |
| `react-hooks(rules-of-hooks)`             | 20   |
| `unicorn(no-useless-spread)`              | 9    |
| `eslint(no-useless-escape)`               | 7    |
| `eslint(no-control-regex)`                | 4    |
| `eslint(no-eval)`                         | 3    |
| `typescript-eslint(no-this-alias)`        | 3    |
| `eslint(no-unsafe-finally)`               | 2    |
| `unicorn(no-new-array)`                   | 2    |
| `eslint(max-lines)`                       | 1    |
| `unicorn(no-useless-length-check)`        | 1    |

八成是 React hooks 的依赖检查，集中在界面层，与我们要改的 Host 与 Agent 运行时关系不大。

### 以后怎么对照

先比条数，再看明细：

```sh
# 在 fork 源码目录执行，条数与 537 比较
pnpm lint 2>&1 | grep -E 'Found [0-9]+ warning'

# 条数变了再看明细：把当前输出规范化成“规则<TAB>说明”，与快照比较，只列出现在有、快照里没有的行
pnpm lint 2>&1 | grep -E '^\s*! ' | awk '{ sub(/^ *[!]+ /, ""); sub(/: /, "\t"); print }' | sort > /tmp/lint-now.txt
cd <ZCode-Manage 目录> && cut -f1,4 docs/baseline/zcode-ee-glm-a4b44451.lint-warnings.tsv | sort > /tmp/lint-base.txt
comm -23 /tmp/lint-now.txt <(sort /tmp/lint-base.txt)
```

比较时不看行号：我们的改动会让上游文件的行号整体移动，带行号比不出有意义的结果。

条数变少通常也是好事：说明上游修掉了一些。

## 三、第一次运行时的一个失败：下载构建工具超时

**现象。** `packages/desktop/test/windowsInstallerCompile.test.ts` 用例超时失败，时限正好是 120 秒。

**它做什么。** 这是 Windows 安装包的编译测试。它先让 electron-builder 下载两份 NSIS 工具包，然后在 Rosetta 下运行 x86_64 的编译器把安装脚本编译五遍。时限 120 秒写死在用例里。

**根因（实测）。** 卡在下载。从 GitHub 的发布资源下载 `nsis-3.0.4.1.7z` 只有 19.6 KB/s，另一份 `nsis-resources-3.4.1.7z` 30 秒内连连接都没建立；缓存里没有编译器，说明后续步骤根本没开始。与代码无关，与 Rosetta 无关（Rosetta 已安装并正常运行）。

**排除过程里的两次误判，一并记录。** 我先猜是没装 Rosetta，核对后不成立；随后想用延长超时来验证，但时限写在用例里，参数覆盖不了，那次重跑只是又超时了一次。结论最终靠直接测量下载速度得出。

**处理。** electron-builder 支持 `ELECTRON_BUILDER_BINARIES_MIRROR` 指定下载镜像，下载后按内置的 SHA-256 校验。用 npmmirror 重跑该用例，5.6 秒通过，工具包进入 `~/Library/Caches/electron-builder/`。之后不设镜像、只靠缓存重跑完整的工程测试，全部通过，即第一节的数字。

**对后续的意义。** 打 Windows 安装包需要同样的工具包，而且不止这两个。这台机器上做 Windows 打包时要带上镜像变量：

```sh
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

换一台机器或清空缓存后，这个用例会再次因为下载超时而失败，先看是不是这个原因。

## 四、日志里的噪音

工程测试的输出里有 18 处 “Build failed with 1 error … The server is being restarted or closed. Request is outdated”。它们由通过的用例打印：这些用例启动 Vite 开发服务器后在依赖扫描完成前把它关掉了。不是失败，看结果只看最后的汇总行。

## 五、依赖安装

`pnpm bootstrap` 在同一状态下执行：2712 个包，`pnpm install` 8 分钟，桌面运行资源准备与全量包构建通过，日志 0 个错误，安装前后工作区无改动。npm 源速度波动大，个别包只有 20 多 KiB/s，没有换源也装完了。

## 六、在钉定工具链下复验，并手工跑完整的推送前检查链

**Node 24.14.0 的来源。** 官方 darwin-arm64 发行包解压在 `~/.local/opt/node-v24.14.0/`，是独立目录，没有改动系统默认的 Node，也没有改 shell 配置。解压前用 SHA-256 校验，结果与 npmmirror 的清单、nodejs.org 的官方清单三方一致。要临时使用：

```sh
export PATH="$HOME/.local/opt/node-v24.14.0/node-v24.14.0-darwin-arm64/bin:$PATH"
```

**复验结果。** 前五节是在 Node v24.10.0 下得到的；换成 24.14.0 后重跑，数字完全相同：类型检查通过，lint 0 个错误、537 个警告，工程测试 1157 个通过、25 个跳过。

**推送前检查链**，即 `pnpm run verify:pre-push`，手工执行，stdin 为空：

| 环节                         | 结果                               |
| ---------------------------- | ---------------------------------- |
| 推送工作区检查               | 通过                               |
| E2E 远程目标检查             | 按设计跳过，提示“私有队列不存在”   |
| lint，含边界与文档工具检查   | 通过，537 个警告                   |
| 文档过时措辞检查             | 通过                               |
| 数据库 schema 检查           | 通过                               |
| 架构治理测试                 | 通过                               |
| 增量架构检查                 | 通过                               |
| 受影响的工程测试             | 没有改动，选中 0 个                |

真正推送时 Git 会把本次推送的引用传给这条链，“受影响的工程测试”才按改动范围选文件；手工执行时它只能得到“没有改动”。

**一项未解的观察。** `bootstrap` 完成后，在同一状态下单独执行 `pnpm install --frozen-lockfile`，pnpm 报告要移除 192 个包，并以极慢的速度下载 `@oxc-resolver/binding-freebsd-x64` 这类其他平台的可选包。我在它改动依赖目录之前中止了。核实过的事实：已安装状态的快照与仓库锁文件逐字一致，依赖目录的修改时间仍停在 `bootstrap` 完成时，所以依赖目录是完好的；仓库自带的脚本和 `bootstrap` 的后续步骤都没有执行过额外的安装。原因没有查清。在弄清之前，这台机器上以 `pnpm bootstrap` 为准，不要在它之后接着跑单独的冻结安装。
