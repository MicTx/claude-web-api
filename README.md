# claude-web-api

让 agent 宿主通过本地浏览器中的 Claude 网页会话获取第二意见，支持连续追问。

[English](README.en.md) · **简体中文**

`claude-web-api` 把一次外部咨询变成可核对的回路：宿主整理授权范围内的上下文，经 MCP、CLI 或技能发起提问，本地桥接在自有后台标签页中读取网页回复，再按会话别名保存状态；执行与验证仍留在当前宿主。它不提供官方 SDK、稳定公共 API 或自动事件 hook，也不替用户授权外部咨询。

**本项目不提供事件 hook。** 已获外部咨询授权时，由宿主主动评估规划、难题攻坚、复杂问题推理；语义匹配不是确定性触发器。正文要给足但精简上下文（默认约 8 KiB），明确要求 ultrathink 深度推理、文件级指导、进取的根因方案，以及带判据和回滚的验证门禁修订；继而附首选方案、前置条件、有序具体步骤、完整命令、成功观测、失败处置与端到端验证。`--guidance` / `guidance: true` 可确定性追加固定指导块，默认不改写正文；结果回报 `guidanceAppended`，旧版或残缺标记不自动补全。所有可执行步骤须标 `已核验` / `需本地核查`，决策须给可证伪点、被否方案与切换条件。详见[可执行端到端指导](docs/usage.md#可执行端到端指导)。

导航：[导览](#文档导航) · [要求](#要求) · [安装](#安装与接入) · [限制](#限制)

## 文档导航

| 你想做什么 | 先读 |
|---|---|
| 理解这套桥接解决什么问题、何时不该用 | [渐进导览](docs/introduction.md) |
| 从可信 Release 安装、升级或回滚 | [中文安装指南](docs/install.md) / [English](docs/install.en.md) |
| 让 LLM 按边界执行安装 | [llms.txt](llms.txt) |
| 查命令、附件、恢复、锁与诊断证据 | [使用说明](docs/usage.md) |
| 核对备用 HTTP 通道的字段与限制 | [API 协议参考](docs/api-protocols.md) |
| 理解网页通道与 Claude 产物边界 | [网页协议摘要](docs/claude-web-protocol.md) / [产物机制摘要](docs/claude-design-protocol.md) |
| 参与开发或安全披露 | [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) |

## 要求

- Node.js >= 22，且 `node` 命令在消费进程与宿主启动进程的 `PATH` 上可用；安装产物不固化 Node 的版本化物理路径。
- 一个已登录 claude.ai 且显式开放 loopback CDP 的本地 Chrome/Chromium；未配置端点时自动发现唯一已登录候选，多候选需显式指定。
- 外部咨询须已有用户授权；网页会话由使用者自备。备用 API 通道可选，需自行核验网关兼容性。

## 安装与接入

**开发仓库不作消费目录。** 从可信的私有 Gitea Release 选择已发布的固定版本，下载并校验 `install.sh`、`SHA256SUMS` 和版本归档；无需 clone、Git 或 npm。本地候选产物不代表远端已发布，不猜测下载地址。完整流程见[中文安装指南](docs/install.md) / [English](docs/install.en.md)，供 agent 执行的协议见 [llms.txt](llms.txt)。

以下在已下载且校验通过的 Release 目录执行，`CCW_VERSION` 为操作者确认的版本，`ASSET`/`DIGEST` 按安装指南取得：

```bash
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST" --dry-run
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST"
bash ./install.sh --status
"$HOME/.local/bin/ccw" --help
"$HOME/.local/bin/ccw" --status
```

运行时在仓库外 `~/.local/share/claude-web-api/runtime/releases/v版本`，命令通过 `current` 解析，并在每次启动时从 `PATH` 查找 `node`；`ccw --status` 是等价的只读运行态检查。重连（reconnect）宿主时须使用新版本安装记录或原管理器刷新，不自动改写用户配置。Bash 不修改宿主配置、不自动重启或发送消息。

### 接入方式

已有 Magpie 等管理器时，保留管理器归属，通过其受支持入口把已有 `claude_web` 指向安装后的 `ccw-mcp` 路径，导入运行目录里的技能，不再添加直连。没有外部管理器且获准修改指定宿主时，使用独立产物里的 `ccw-hosts`（示例 `dsh` 须先确认归属）：

```bash
"$HOME/.local/bin/ccw-hosts" --list
"$HOME/.local/bin/ccw-hosts" --host dsh --dry-run
"$HOME/.local/bin/ccw-hosts" --host dsh
"$HOME/.local/bin/ccw-hosts" --check --host dsh
```

原生插件与直连 MCP 二选一；当前独立 Release 以 CLI/MCP/技能为主，未提供已发布插件资产时不要猜下载链接。只装 Codex 时同样用 `ccw-hosts --host codex`，先排除 Magpie 或原生插件重复入口；注册与 `runtime.json` 应指向独立运行根。`codex` 插件验收与结构治理命令见[开发与测试](#开发与测试不是消费安装)。

| 宿主 | MCP 注册位置 | 技能 | 状态 |
|---|---|---|---|
| Codex CLI | `~/.codex/config.toml` 的 `[mcp_servers.claude_web]` | `~/.codex/skills` | 已核验 |
| Claude Code | `~/.claude.json` 的 `mcpServers.claude_web` | `~/.claude/skills` | 已核验 |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` 的 `mcpServers.claude_web` | 无技能目录 | 路径已核验 |
| Pi agent | `~/.pi/agent/mcp.json` 的 `mcpServers.claude_web` | `~/.pi/agent/skills` | 已核验 |
| DeepSeek Harness | `~/.deepseek/mcp.json` 的 `servers.claude_web` | `~/.deepseek/skills` | 已核验 |
| Gemini CLI | `~/.gemini/settings.json` 的 `mcpServers.claude_web` | `~/.gemini/skills` | 已核验 |
| OpenCode | `~/.config/opencode/opencode.json` 的 `mcp.claude_web` | `~/.config/opencode/skills` | 已核验 |
| Grok Build | `~/.grok/config.toml` 的 `[mcp_servers.claude_web]` | 未核验，不安装 | 结构已核验、运行时未实测 |

表中“已核验”指安装适配器的配置级测试，不是所有客户端均已重载验收。cc-switch 宿主清单中的 openclaw、hermes、mcode、kimi、agy、omp 配置位置与 schema 未核验，安装器只在 `--list` 中报告，不猜测写入。宿主可用 `claude_ask` / `claude_follow_up` / `claude_sessions` / `claude_transcript` / `claude_doctor` / `claude_download` 与 `claude` 技能；装完须重连 MCP 或重载技能。

写入所有权只认安装记录：记录保存在 `$CCW_STATE_DIR`，默认 `~/.local/share/claude-web-api/installs/`；Codex 沿用历史路径。已核对的 Magpie hub/外部直连只报告 `configured:true`、`installed:false`，安装时 `skippedExternal:true`，不重复注册或接管；未知同名条目仍报 `INSTALL_CONFLICT`。条目被删掉后卸载仍收尾，条目被改动则报 `OWNED_MODIFIED` 且不删用户内容。检测到并发原地编辑时保留恢复文件并报错；安装期间应停止其他配置编辑。归属（ownership）核验不采纳链接或未知记录。

### 证据分层与恢复

```bash
"$HOME/.local/bin/ccw-hosts" --check --host pi
"$HOME/.local/bin/ccw-hosts" --check --probe --host pi
# 明确授权发现式 hub 的只读元数据检查时：
"$HOME/.local/bin/ccw-hosts" --check --discover --host pi
"$HOME/.local/bin/ccw-hosts" --reconcile --dry-run --host codex
```

普通 `--check` 零网络/零写入；`source.verification:"configuration-only"` 不表示端点在线，并只读报告外部管理技能副本是否与当前运行时一致。`externalSkill.status:"stale"` 是独立新鲜度证据，不改变健康路由（healthy route）的配置层结论。Magpie `sharedSkills:true` 时，所有资源库技能都链接到 `~/.agents/skills`，读该目录的 Agent 会看到全部技能，不按逐 Agent 勾选隔离；检查器跟随共享链接并加记 `externalSkill.shared:true`，但不推断 Agent 已实际加载。显式 `--probe` 只对已核对的本机路由执行有界 initialize/tools/list，检查六工具和两个发送 schema 的完整指导块；`verification:"protocol-only"`、`hostLoaded:false` 仍须实际宿主安全重连。发现式 hub 只暴露元工具时返回 `PROBE_DISCOVERY_ONLY`，后端 schema (`discovery-schemas`) 标为未核验；明确授权时可另用 `--check --discover`，只调用 `claude_web__claude_download`、`claude_web__claude_doctor` 两个精确 `find_tools` 元数据查询，不调用 `call_tool`、不发送 Claude。`DISCOVERY_*` 旧缓存只诊断，不自动刷新/重启。

`--reconcile` 是恢复而非安装：预览后，仅在原像/归属核对及写入授权具备时去掉 `--dry-run`。只回收本运行时失效且无注册/技能目标的有效记录，或精确的空孤立起始标记；先保存私有前像，拒绝链接、未知归属、锁与并发变化，失败保留 `recoveryPath`。`--check --all` 仍报告未安装者，不要求靠批量安装变绿。详见[恢复和证据分层](docs/usage.md#多源证据与显式恢复)。

### CLI 直接使用

提示文本优先经 stdin 或文件传入：

```bash
"$HOME/.local/bin/ccw" ask --session architecture --stdin <<'QUESTION'
请只读规划本项目的最小离线验收方案。已知 Node.js >=22，npm test 运行离线测试。
请用 ultrathink 深度推理，先给结论和进取的根因首选方案、前置条件；再按序给文件级具体改动点（路径、符号、行号）或动作、完整命令及运行目录、成功观测、失败处置和最终端到端验证。验证门禁不合理时给出替代判据、证据与回滚；证据不足先给可执行取证步骤，不编造路径或结果。
QUESTION
"$HOME/.local/bin/ccw" follow-up --session architecture --stdin <<'QUESTION'
请只补充上一轮仍缺失的执行细节：针对首选方案给出具体位置、完整验证命令、通过标准、反例及失败后的下一步。未确认的实现标明需本地核查。
QUESTION
"$HOME/.local/bin/ccw" transcript --session architecture
"$HOME/.local/bin/ccw" transcript --session architecture --recover
```

结果为单行 JSON，失败退出非零。`--recover` 只在对服务端历史核对通过时清除 pending。完整命令、附件、超时、锁、并发和 pending 规则见[使用说明](docs/usage.md)。

## 配置与可选通道

CLI、MCP、插件共用只读的 `$HOME/.config/claude-web-api/config.json`；缺省不创建文件、不启用上传。部分宿主会过滤环境变量，MCP/插件应由用户通过此文件配置浏览器和批准的文件根。上传仅支持显式选择的 PNG、UTF-8 `.js`，拒绝 PDF 和伪装为代码的 PDF；不上传仓库、不展开目录或 import。返回的 PDF 聊天文件仍可下载。文件身份、草稿恢复与 `PROMPT_MISMATCH` 边界见[使用说明](docs/usage.md#显式附件与回拉)。

`CCW_CDP_URL`（默认为空并自动发现）、`CCW_STATE_DIR`、`CCW_TIMEOUT_MS`、`CCW_ATTACHMENT_ROOT` 等变量可覆盖配置文件。以下只列会影响选路的参数，完整默认值见[使用说明](docs/usage.md#启动配置)：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCW_BACKEND` | `web` | `web` / `api` / `auto`：是否允许备用 API 通道 |
| `CCW_API_BASE_URL` | 空 | 备用端点，必须 HTTPS（仅 loopback 测试允许 HTTP） |
| `CCW_API_MODEL` | 空 | 新 API 别名未配置时选宿主目录最新 Opus；`ccw ask --model` 可显式选模 |
| `CCW_API_KEY_FILE` | 空 | 备用密钥文件绝对路径（非链接、`0600`、≤ 8 KiB） |
| `CCW_API_MAX_TOKENS` | `2048` | 严格输出上限，推理消耗也计入 |
| `CCW_API_CONTEXT_TOKENS` | `16000` | 每次发送输入历史的保守估算预算 |
| `CCW_API_PROTOCOL` | `messages` | `messages` / `chat` / `responses`，别名创建后固定 |
| `CCW_API_CACHE` | `ephemeral` | Messages 前缀缓存断点；`off` 不发送断点 |
| `CCW_API_REASONING` | `off` | 推理强度；`off` 不发强度字段，不等于关闭思考 |

网页不可用时可启用独立 HTTP 备用端点，`apiProtocol` 可选 `messages`（默认）/ `chat` / `responses`；`backend=auto` 只对**新别名**在发送前做一次只读网页预检，失败才改用它。按次显式选路用 `ccw web <命令>` 或 `ccw api <命令>`：覆盖配置、不预检、永不回落；别名归属不符报 `MODE_MISMATCH`。该通道是**纯文本、粘性会话**：不接收附件、不请求网页产物、不提供产物下载。本地保留完整文本历史，发送时选取 `apiContextTokens` 预算内且实际 JSON 不超过 256 KiB 的最新完整轮次；同一别名单请求在途，不同别名可并发发送并各自落盘。推理等级按协议发送：Messages 用 `thinking: {"type":"adaptive"}` + `output_config.effort`，Chat 用 `reasoning_effort`，Responses 用 `reasoning.effort`。`ccw doctor` 显示实际字段；HTTP 200 不证明 effort 生效，缺失思考用量记 `usage.reasoningTokens: null`。协议字段、SSE 累计语义、`API_STREAM_INCOMPLETE`、pending、429、`store: false` 和验收边界见[API 协议参考](docs/api-protocols.md)。

发送结果不确定时保留 pending 且不重发，先用 `transcript` 核对；超时、断流、取消、重定向、认证和契约错误都不会触发 POST 重试。`complete: false` 表示回复已终止但内容截断，备用 API 放弃未确认尝试须显式 `--discard-pending`。密钥变化阻止旧历史发送，轮换须用 `ccw api-bind-credential` 显式校验；不声称缓存命中或省钱，除非观察到服务端 usage。

网页新别名也支持 `--model`；未指定时从宿主目录与网页可见菜单的交集选最新 Claude Opus，并通过控件回读及会话/发送回执核对。追问不能换模型，旧别名不迁移。`ccw doctor` 只读展示宿主、网页及默认选择证据，不代替真实网页切模验收。

## 开发与测试（不是消费安装）

仅在开发仓库运行；不要把以下源码入口注册进生产宿主：

```bash
npm ci
npm test
npm run build:release
npm run build:plugin
npm run verify:plugin
npm run verify:structure
```

源码安装 CLI `scripts/install-agents.mjs` 仅供开发夹具/临时 HOME 调试；消费者使用 Release 的 `ccw-hosts`。构建输出仍是候选产物，须经发布门禁。`verify:plugin` 在 `build:plugin` 之后验证隔离的临时 CODEX_HOME 插件安装与 MCP 握手，需要 PATH 上的 `codex` CLI；测试全部离线运行，不接触真实账号、浏览器与个人宿主配置。`verify:structure` 从 Git tracked 文件与真实直接 import 生成 `.spec/architecture/*` 并校验模块 DAG 无环；修改治理文件后运行 `npm run verify:structure -- --write` 重新生成。

## 限制

- 网页会话会创建真实对话并消耗账号配额；`quota` 仅是旧 SSE 快照，原生发送返回 `null`，不能作为硬预算。claude.ai 的接口、选择器和文件协议均非公开稳定契约，随时可能变化。
- 上传证据覆盖恢复草稿提交后的 PNG 和 JS；移除 PDF 后的独立自动上传流程尚未重新进行真实验收。`download` 产物须在本地独立核对，不执行、不覆盖、不解压。
- 多宿主安装器的验收覆盖配置写入/校验/卸载与 MCP 握手；Claude Desktop、Grok Build、Gemini CLI 未做真实宿主加载工具的运行时验收。
- 备用 API 通道的网关兼容性、模型真实性和服务端会话亲和需由启动方自行核验；本地测试只覆盖请求形状、状态机与安全边界。
- 发送结果不确定时不自动重发；先用 `transcript` 核对，必要时 `unlock` 释放死亡锁。

## 社区与许可

- 缺陷与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)；行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 安全披露：[SECURITY.md](SECURITY.md)；版本差异：[CHANGELOG.md](CHANGELOG.md)。
- 软件按 [PolyForm Noncommercial 1.0.0](LICENSE) 授权；版权通知见 [NOTICE](NOTICE)；商业使用须另行取得书面授权。

深入说明见 [docs/usage.md](docs/usage.md)。
