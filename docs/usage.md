# 使用说明

本文覆盖 `ccw` CLI 与 MCP 工具的运行语义和实测边界。安装、升级与回滚使用[固定 Release 安装指南](install.md)；开发仓库不作消费场所。以下 `ccw` / `ccw-hosts` 指独立安装后的命令，未加入 PATH 时使用 `$HOME/.local/bin/` 下的绝对入口。

## 持续协作

启用 `claude` 后，可以要求：

> 和 Claude 一起推进当前任务，直到本阶段验收完成。当前宿主会话负责执行和验证，Claude 持续复审结果。

循环由**当前宿主会话**驱动（Codex、Claude Code、Pi、DeepSeek Harness 等），不是另起一个后台 agent 进程：

1. 界定阶段目标、允许改动的范围和验收标准，把必要上下文交给 Claude。
2. 宿主会话对照本地事实执行小步工作并验证。
3. 使用同一 `session` 把实际结果和未解决问题交给 Claude 复审。
4. 修正有效问题、复验、回传新证据，直到当前阶段完成。

停止依据不是“Claude 已回答”或双方口头同意，而是当前标准有验证证据、最后一轮复审覆盖最新状态、本阶段有效问题有明确处置。阶段完成不代表整个项目完成，也不自动授权开始新阶段。

遇到用户停止、权限或外部阻塞、登录/限流、用户预算上限，或连续两轮没有新增执行结果、证据或问题处置时，**暂停而非宣称完成**。当前宿主会话保留阶段标准、已验证结果、未解决项、会话别名和恢复条件；恢复时复用同一会话，先核对 pending。

明确要求“只问一次”“只要意见”时保持一次性咨询，不自动扩成代码修改。持续协作也不扩大上传、执行、删除、提交或推送权限；只发送授权的必要上下文和脱敏证据。

技能原文定义完整协议；MCP 的 `initialize.instructions` 和发送工具说明提供相应指引。它们不是强制调度器，桥接程序不会自行发起下一轮，CLI 每次也只执行一条命令。协议、初始化传输和安装分发测试不等于真实模型行为验收。

构建或更新源码后，已安装的技能或插件缓存不会自行刷新。消费者须使用已校验的新 Release 升级，再按原管理器归属更新技能并重连 MCP；不把宿主指向 worktree/dist。安装器仍会拒绝覆盖用户定制过的受管文件。安装命令与直连 MCP 注册只保存 PATH 上的 `node` 命令名；升级 Node 运行时后仍须重连宿主，旧记录若绑定已消失的物理路径会由 `--check` 报出，再经新版本安装器或原管理器显式刷新。

### 场景评估不是事件 hook

**本项目不提供事件 hook**，安装器不会写入 `UserPromptSubmit`、`before_agent_start` 或其他宿主事件设置。技能 description 的语义匹配和 MCP 操作指令不是确定性自动触发；仓库外的用户自定义 hook 未由本项目审计或管理。

| 场景 | 已获外部咨询授权后的宿主动作 |
|---|---|
| 规划 | 范围、依赖或验收有关键取舍时，要求 Claude 给最小实施路径和可证伪的验证 |
| 难题攻坚 | 定位停滞或证据矛盾时，带最小复现和已失败路径，索取下一项具体诊断 |
| 复杂问题推理 | 跨模块因果、状态机或并发约束难以判断时，要求首选方案、反例与可运行验证，不索取隐藏思维链 |

已有授权内可主动评估，无需每轮重复点名 Claude；未获授权时只提示，不自动外发。简单本地问题不默认咨询；只读、只问一次、预算和用户中止优先。

### 可执行端到端指导

`initialize.instructions` 只到宿主，不自动进入被咨询 Claude 的上下文。宿主须把适用的固定指导块真正写入 `claude_ask` / `claude_follow_up` 的 prompt，原样保留获准发送且不含敏感信息的用户请求；需要脱敏时明确标为脱敏摘要。桥接层默认不改写正文；显式传 `guidance: true`（CLI `--guidance`）且正文没有指导标记时，才在发送前追加固定块并回报 `guidanceAppended`。已有任意版本标记不重复追加，也不替换调用方自己写的版本。检测仅识别标题标记：只出现标题、截断块或旧版块也会跳过追加；`guidanceAppended:false` 不证明包含完整 v3，宿主必须自行核对。

上下文要足够但精简：阶段目标、允许范围、验收标准、已确认事实与最小证据（仓库相对路径、符号、行号、关键片段、失败命令与决定性输出）。默认正文约 8 KiB；不粘贴整文件、完整历史或无关日志，追问只发增量。规划、难题攻坚和复杂问题推理还须显式要求 ultrathink 深度推理、文件级指导和进取的根因方案。

回复验收按 6 项逐条检查，任一缺失都不能当作可执行交付：

1. 决策：首选方案、被否方案、切换触发与回滚齐全，且首选方案至少有一个可证伪点与检测命令。
2. 执行单元：每步含路径/符号、改动、命令（含运行目录）或手工操作、具体成功观测、失败分支与依赖序。
3. 证据层级：关键事实和步骤标明 `已核验` 或 `需本地核查`；需本地核查的未核验步骤先有取证命令。
4. 根因：方案解决根因而非只加防御层；验证门禁不合理时给出替代判据、证据与回滚。
5. 端到端验证：有最终验证方法、通过标准，并区分建议执行与实际已执行。
6. 范围：未扩大当前阶段、只读/一次性限制与调用预算；缺事实时先给最小可执行取证步骤。

固定指导块以开发源中的 `EXECUTABLE_GUIDANCE_CONTRACT` 为真源；[已分发技能](../skills/claude/SKILL.md) 有逐字一致的可复制版本，两个发送工具的 prompt schema 也自含完整块，因此不依赖 initialize 未被截短。直接 CLI 调用仍须显式写入要求，不从开发目录导入。前置为已安装 Release、浏览器已登录、此次咨询已授权且选择未使用别名；任意工作目录执行：

```bash
"$HOME/.local/bin/ccw" ask --session offline-plan --stdin <<'PROMPT'
用户原始请求：只读规划 MCP 与技能安装的最小验收，不修改文件。
已知事实：Node.js >=22，已安装独立 Release；<按需填写仓库相对路径、符号、行号与关键片段>；没有提供内部源码，不得假称读过。
请用 ultrathink 深度推理，先给进取的根因首选方案；指导细化到文件和符号；现有验证门禁不合理时给出替代判据、证据与回滚。再给前置条件、有序具体动作及完整命令和运行目录、成功观测、失败处置与端到端验证；缺事实先给取证步骤，只索取最小必要事实。只问一次，不追加发送。
PROMPT
```

需要固定全文时，从当前技能中的 text 围栏复制并附加到正文，不从源码模块拼接或在恢复时重新生成正文。也可以给同一条命令加 `--guidance`（MCP `guidance: true`），由桥接在正文没有指导标记时追加固定块；默认不改写正文，结果的 `guidanceAppended` 表示本次是否追加。

收到回复先按 6 项判据做**回复验收**，不能把只有框架的回答直接转述为完成。同时确认方案解决根因、指导到文件，验证门禁修订有替代判据、证据与回滚；门禁修订须先在本地核实证据，涉及用户设定的验收标准、权限或不可逆操作仍须用户确认。上一轮已终止且没有未确认 pending 时，用同一别名只追问缺项或回传实际验证证据，每条适用追问仍附指导块；这是新问题，不是重放。`complete: false` 要报告截断，按预算决定是否另问缺失部分；只问一次时直接报告缺口，不追加调用。超时或断线必须先读 transcript 并对账，不为补要求换别名、换通道或重发原问题。

验证分三层：静态契约测试证明文本和安装载荷一致；传输测试证明宿主收到指引、调用者正文不变且 pending 阻止重发；真实 Claude 回复只证明当次样本的可执行性。前两层不证明模型遵守，一次真实样本也不证明所有宿主稳定自动触发。

### 可选：Claude Code PreToolUse 加固（用户自管）

本项目仍不提供事件 hook，安装器也不写宿主事件配置。需要输入侧兜底的 Claude Code 用户可自行添加 PreToolUse 钩子：在 `settings.json` 中匹配发送工具；仅当 `guidance === true` 或正文包含指导标记时放行，否则以退出码 2 阻止调用。开关放行要求实际宿主端点支持 `guidance`；使用旧版端点前先升级并验证 schema，旧端点不能由该 hook 自动获得注入功能。脚本示例（由用户自行保存、审计和维护，本项目不安装、不更新、不审计）：

```js
// check-guidance-hook.mjs
import { readFileSync } from 'node:fs';
const event = JSON.parse(readFileSync(0, 'utf8'));
const input = event?.tool_input ?? {};
const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const hasMarker = /【可执行指导要求(?: v\d+)?】/.test(prompt);
if (input.guidance !== true && !hasMarker) {
  console.error('缺少可执行指导块：请传 guidance=true，或按技能固定块组装正文');
  process.exit(2);
}
```

```json
{"hooks":{"PreToolUse":[{"matcher":"^mcp__(magpie__)?claude_web__claude_(ask|follow_up)$","hooks":[{"type":"command","command":"node /absolute/path/check-guidance-hook.mjs","onFailure":"block"}]}]}}
```

该同步 command hook 的 `onFailure:"block"` 要求 Claude Code v2.1.295 或更新版，用于脚本无法启动、异常退出或超时时阻断；不要设为异步。实际行为应在当前宿主版本中验证。matcher 只覆盖直连 `claude_web` 与 `magpie` 中直接暴露的两个发送工具，不覆盖 CLI、其他宿主或 discovery hub 的间接工具；其他注册名须按实际 `tool_name` 调整。它只检查开关或标记，不验证指导块的内容或完整性，也不检查回复是否可执行；不能由此声称模型遵守或语义触发已变为自动触发。安装前先在隔离测试宿主用**未配置真实服务的合成 MCP**执行一次缺少标记的调用，确认工具未执行且收到退出码 2 提示；带合成标记和带 `guidance:true` 的调用分别放行。核对事件 `tool_name`，未触发时停止并修正 matcher，不用真实咨询来试错。其余支持的宿主可使用 `guidance: true` / `--guidance` 选择桥接注入。

## 多宿主安装

同一份已安装 Release 可接入多个宿主。`ccw-hosts` 包装产物中的 `scripts/install-agents.mjs`，只适用于确认无 Magpie/其他管理器的直连宿主；外部管理入口使用安装后的绝对 `ccw-mcp` 路径，不能重复注册。直连适配器只写自己的注册，保留其他配置字节。

| 宿主 | 宿主 id | 配置位置 | 注册容器 | 技能目录 |
|---|---|---|---|---|
| Codex CLI | `codex` | `~/.codex/config.toml` | `[mcp_servers.claude_web]`（含 `tool_timeout_sec=660`、`startup_timeout_sec=20`） | `~/.codex/skills` |
| Claude Code | `claude` | `~/.claude.json` | `mcpServers.claude_web`（`type:"stdio"`） | `~/.claude/skills` |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.claude_web` | 无（桌面端无技能目录） |
| Pi agent | `pi` | `~/.pi/agent/mcp.json` | `mcpServers.claude_web` | `~/.pi/agent/skills` |
| DeepSeek Harness | `dsh` | `~/.deepseek/mcp.json` | `servers.claude_web`（`execute_timeout=660`） | `~/.deepseek/skills` |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` | `mcpServers.claude_web` | `~/.gemini/skills` |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` | `mcp.claude_web`（`type:"local"`，`command` 为数组） | `~/.config/opencode/skills` |
| Grok Build | `grokbuild` | `~/.grok/config.toml` | `[mcp_servers.claude_web]`（仅 `command`/`args`） | 未核验，不安装 |

```bash
"$HOME/.local/bin/ccw-hosts" --list
"$HOME/.local/bin/ccw-hosts" --host dsh --dry-run
"$HOME/.local/bin/ccw-hosts" --host dsh
"$HOME/.local/bin/ccw-hosts" --check --host dsh
# 仅获准卸载同一条直连时：
"$HOME/.local/bin/ccw-hosts" --uninstall --host dsh
```

- 宿主目录可用其原生环境变量覆盖：`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR`、`DEEPSEEK_HOME`、`XDG_CONFIG_HOME`；`--home <id>=<绝对路径>` 优先于环境变量，但只覆盖单个宿主，不隔离 Magpie Library；需要全 HOME 隔离时把进程 `HOME` 一起指向临时根。
- 路径参数按平台校验：状态目录（`--state-dir`，以及缺省时的 `CCW_STATE_DIR`）必须是绝对路径，写成相对路径会直接 `INVALID_ARGUMENT` 退出且不写盘——否则记录会落到当前工作目录，换个目录执行 `--check` 就查不到安装；`--home` 的绝对性按运行平台判断（Windows 下 `C:\…` 合规，POSIX 下需 `/…`）。
- 写入所有权只认安装记录：JSON 宿主的记录在 `$CCW_STATE_DIR/installs/<host>.json`（默认 `~/.local/share/claude-web-api/installs`），Codex 沿用 `~/.codex/claude-web-api-install.json`。经过当前运行时路径/Library 声明核对的外部入口只读报告、安装时跳过；未核对的同名条目仍 `INSTALL_CONFLICT`，不采纳、不改写、不删除。
- 卸载按字节还原：JSON 宿主用文本级成员拼接（插入/移除只动自己那一段，每次变更重新解析并与目标对象深比较），TOML 宿主用受管块标记；安装器新建的文件在卸载时整体删除。
- 条目被手工改动后，安装/卸载报 `OWNED_MODIFIED`，`--check` 把它列为问题；技能文件被定制时同样拒绝覆盖。
- 外部删除不是冲突：自己的条目、容器或整份配置文件被别的工具删掉后，卸载仍以 0 退出并清理安装记录与本技能副本，不重建、不改写用户剩余的字节；重装即可重新注册。
- Release 的新增安装要求显式 `--host`，防止盲目批量注册。内部开发引擎的默认安装只覆盖已检测宿主，check/uninstall 还覆盖残留记录；消费者不能因此推断外部来源健康或默认卸载外部内容。`--check --all` 包含未安装宿主，非零不等于所有服务不可用。
- DeepSeek Harness 的 `execute_timeout` 默认 60 秒，短于一次真实咨询，因此注册时写入 660 秒；其余宿主用自身默认超时。
- Grok Build 的注册位置来自 cc-switch 的证据，本机未安装，故只写 `command`/`args`；如该宿主对长工具调用有默认超时限制，需由使用方自行调整，安装器不写未核验的键。
- cc-switch 宿主清单中另外几项（openclaw、hermes、mcode、kimi、agy、omp）的配置位置与 schema 未核验，`--list` 会显示其不支持原因，安装器绝不猜测写入。
- 装完需重连 MCP 或重载技能；安装不会改动宿主的其他设置，也不会写宿主的凭据或环境变量。
- 入口技能目录为 `skills/claude`：从 0.1.x 的 `claude-consult` 升级时，记录在案的技能树会自动迁移到新目录；无记录的同名目录不被接管也不被删除，可在卸载后手工清理。

### 多源证据与显式恢复

从任意工作目录调用已安装 `ccw-hosts`；前置为 Node.js >=22、所选宿主配置可读。检查不会通过安装记录推断外部入口损坏，也不读取 Magpie 摘要缓存作为健康证明：

```bash
"$HOME/.local/bin/ccw-hosts" --check --host pi
# 显式允许本机 MCP 元数据探测时：
"$HOME/.local/bin/ccw-hosts" --check --probe --host pi
# 明确授权发现式 hub 的只读后端 schema 检查时：
"$HOME/.local/bin/ccw-hosts" --check --discover --host pi
# 只做历史恢复预览，不联网、不创建锁或备份：
"$HOME/.local/bin/ccw-hosts" --reconcile --dry-run --host codex
```

| 观测 | 能证明什么 | 不能证明什么 |
|---|---|---|
| `source.kind: magpie-hub` / `magpie-direct` / `external-direct`，`configured:true`、`installed:false` | 当前已启用的实际路由与已核对运行时/Library 声明一致；写权限仍属于外部管理器 | 端点在线、实际宿主已加载、模型会遵守 |
| `source.kind: installer` | 继续用本安装器记录与配置/技能校验；损坏记录不能变成外部健康捷径 | 不代表外部 Library 归属 |
| `source.kind: none` / `unknown` / `conflict` | 如实区分未安装、证据不足和双源冲突，非零退出 | 不自动安装、接管或卸载 |
| 普通 `--check`，`verification:"configuration-only"` | 只读配置层；零网络、零锁、零写；外部技能副本新鲜度单列 `externalSkill.status`；`sharedSkills:true` 时核对 `~/.agents/skills` 共享链接并标 `externalSkill.shared:true`，不按勾选过滤 | 不做协议或模型验证；不改写资源库副本，不推断每个 Agent 已加载；陈旧副本不改变健康路由配置结论 |
| `--probe`，`verification:"protocol-only"`、`hostLoaded:false` | 仅 initialize/tools/list；六工具及两个发送 schema 含完整固定块，初始化被摘要化可以单列 | 不发 tools/call/Claude，不证明真实宿主已重连 |
| `--discover`，`verification:"discovery-schemas"`、`hostLoaded:false` | 对已核对发现式 hub 发两次精确 `find_tools` 元数据查询；合并后核对六工具及两个发送 schema 全文 | 不调用 `call_tool`，不证明真实宿主已加载，不自动刷新缓存 |

外部直连只能匹配当前受信运行时的实际路径，或逐字核对的已安装 `ccw-mcp` shim；旧源码入口在迁移后的检查中不会被自动当成新 Release。未知命令、命令参数、越界链接和伪装同名脚本不执行。hub 配置识别只允许精确 loopback HTTP 路由且无凭据/查询串；实际探测进一步要求 `127.0.0.1` / `[::1]` 字面地址，拒绝 `localhost` DNS 别名与重定向，不转发配置中的认证头或进程环境、不订阅后台 SSE、不重试或清理服务端会话。默认总期限 5 秒，单响应 1 MiB、总响应 4 MiB、最多 8 页工具列表；断线/超时/缺工具/旧 schema 明确失败。

发现式 hub 可能只列 `find_tools` / `call_tool`，返回 `PROBE_DISCOVERY_ONLY`、`reachable:true`、`guidanceInSendSchemas:null`；这是后端 schema 未核验，不是缺工具或缓存陈旧。默认 `--probe` 保持只允许 initialize/tools/list，不自动调用元工具。明确授权时可运行 `--check --discover --host <id>`：只对精确 loopback hub 发 `find_tools({server:"claude_web",query:"claude_web__claude_download"})` 与 `find_tools({server:"claude_web",query:"claude_web__claude_doctor"})`，因为有界结果可能把第六个工具列在 “Also matching” 摘要而省略参数；合并两份 JSON 数组后核对六工具及两个发送 schema 全文，不调用 `call_tool` 发送问题，也不为此追加直连或重启网关。该入口默认 5 秒总期限、单响应 1 MiB、总响应 4 MiB、最多 8 个 MCP 请求；失败返回 `DISCOVERY_*`，不泄露远端响应体、stderr 或配置值。

`PROBE_STALE_SCHEMA` 表示直接列出工具的端点可达但缺工具或元数据未更新：先通过原管理器的受支持入口指向已验证 Release，再安全重连该宿主并查看其实际工具列表。端点完整而宿主工具仍旧时只处理该宿主支持的刷新/重载；没有已确认的入口就报告待操作者处理，不强杀网关、不改磁盘缓存。配置检查、端点协议、实际宿主加载和真实 Claude 样本分别列证据，不能互相替代。

只读诊断的状态码集中对照：

| 状态码 | 层 | 含义 | 退出/后续 |
|---|---|---|---|
| `PROBE_DISCOVERY_ONLY` | `--probe` | hub 仅列 `find_tools`/`call_tool`，后端 schema 未核验 | `reachable:true`、非致命，改用 `--discover` 核验 |
| `PROBE_CONFIG_UNHEALTHY` | `--probe` | 配置归属未核对，未联系端点 | 跳过该宿主 probe，先修配置层 |
| `PROBE_METHOD_REFUSED` | `--probe` | 探测企图发送 initialize/tools/list 以外的方法 | 拒绝，不发请求 |
| `PROBE_STALE_SCHEMA` | `--probe` | 端点可达但缺工具或 schema 陈旧 | 重指已验证 Release 后安全重连该宿主 |
| `DISCOVERY_CONFIG_UNHEALTHY` | `--discover` | 配置归属未核对，未联系端点 | 跳过，先修配置层 |
| `DISCOVERY_ROUTE_REFUSED` | `--discover` | 路由非已核验的精确 loopback hub | 非零退出；直连宿主本就不该用 `--discover` |
| `DISCOVERY_*`（其余） | `--discover` | 有界 find_tools 超时/超限/无效响应 | 非零，不泄露响应体或配置值 |
| `RELEASE_REQUIRED` | host wrapper | 非当前已验证 Release 入口或 root 不一致 | 非零，使用已安装 `ccw-hosts` shim |

**显式恢复的执行条件：** 当前任务已授权写入；旧备份及目标所有权已经核对；无编辑器/安装器/咨询在途；先读 `--reconcile --dry-run --host <id>` 的 `actions`。只有计划精确且无冲突，才运行同参数去掉 `--dry-run`。不把预览当授权，也不为解除阻碍自动处理未知内容。

允许动作仅两种：

1. 有效、路径属于本运行时的失效安装记录，且本项目注册和技能目标均已消失：备份记录后回收，不删除外部 hub 或其他配置。
2. TOML 精确单个孤立 `# >>> claude-web-api >>>`，不含结束标记、本项目注册或下一节前的正文：仅去掉该注释行，其后其他 TOML 段逐字保留，并前后解析比较语义。标记不是一般写权限证明。

执行前的私有备份放在 `$CCW_STATE_DIR/install-recovery/<id>/`（目录 `0700`、前像/日志 `0600`），包含摘要与操作计划；写后核验目标和 `COMMITTED`。符号链接/祖先链接、其他运行时的旧记录、未知归属、存活技能、损坏语法、安装/咨询锁或并发编辑都拒绝；只读外部来源允许的 HOME 内配置链接不赋予恢复写穿权限。失败非零并保留 `recoveryPath`，部分失败不要盲重跑、覆盖原像或清锁，应先把当前文件与备份/日志逐项核对。这个入口不恢复未知历史，也不迁移共享技能或修改 Library。

`--probe` 和 `--discover` 均仅可与 `--check` 合用，二者互斥，不能和 `--dry-run`/安装/卸载/恢复合用；`--check`、`--uninstall`、`--reconcile`、`--list` 互斥。`--all` 不代表所有宿主应安装，未安装者保持非零报告；每个宿主的失败独立，其他选定宿主仍有自己的结果。

## 工作原理

- 每次网络操作通过 CDP 新建一个后台 claude.ai 标签页。旧文本会话走 REST + SSE；附件、新版会话或显式 `native` 走原生编辑器，并从服务端当前分支核对结果。发送前选择通道，失败后不切换通道重试。
- 新网页会话在创建前用可访问菜单选择并回读模型；菜单按展开状态打开/关闭，等待受 `readyTimeoutMs` 约束。原生发送若遇到发送按钮暂时禁用，会在同一窗口内重核服务端父节点和草稿身份，按钮可用后只点击一次；持续不可用则保留 `send` pending 和标签页，成功结果用 `autoRecovered:true` 标明曾等待后恢复。
- 只导航和操作本次自建页，结束后仅关闭仍处于预期位置的自有页。不导航、不读取、不关闭用户已有标签页；自建页被接管或出现用户草稿时停止并保留该页。
- 所有 HTTP 流量都从页面发出：cookie、TLS 指纹、出口 IP 与正常网页一致；Node 侧不复刻请求头，也不读取/导出 cookie 或会话密钥。
- 追问的父指针取自**服务端当前分支**（`current_leaf_message_uuid` 到根的父链），而不是本地缓存的叶子。

## 启动配置

进程启动时只读 `$HOME/.config/claude-web-api/config.json`；不创建或改写它。文件缺失时使用默认值，上传仍禁用，但纯文本发送不受影响。由用户选择并创建配置，不由模型自行扩大授权根：

```json
{
  "attachmentRoot": "~/approved-files"
}
```

`~/...` 和 `$HOME/...` 会按启动进程的 HOME 展开；目录必须已存在、严格位于 HOME 内，且不能指向 HOME 本身。不会自动创建附件目录。也可使用绝对目录，但应避免把特定机器的用户名或路径写入可移植配置。配置文件须属于当前用户，是非链接的普通文件，最多 16 KiB，不能被组/其他用户写入（建议 `0600`）；未知字段、无效类型、文件替换和错误内容均拒绝，错误不回显内容。

| JSON 字段 | 对应环境变量 | 默认 / 约束 |
|---|---|---|
| `cdpUrl` | `CCW_CDP_URL` | `null`；未显式配置时自动发现，配置后仅接受 loopback HTTP 和显式端口 |
| `stateDir` | `CCW_STATE_DIR` | `$HOME/.local/share/claude-web-api`；绝对路径 |
| `orgId` | `CCW_ORG_ID` | `null`；多个 chat 组织时必须指定 UUID |
| `attachmentRoot` | `CCW_ATTACHMENT_ROOT` | `null` 禁止上传；启用时可用已有的 `~/...`、`$HOME/...` 或绝对目录；相对形式必须严格位于 HOME 内 |
| `downloadRoot` | `CCW_DOWNLOAD_ROOT` | `null` 使用状态目录的 `downloads`；自定义根须已存在 |
| `timeoutMs` | `CCW_TIMEOUT_MS` | `600000`；1000–600000 |
| `idleTimeoutMs` | `CCW_IDLE_TIMEOUT_MS` | `120000`；正整数，不大于总超时 |
| `readyTimeoutMs` | `CCW_READY_TIMEOUT_MS` | `30000`；1–600000 |
| `minIntervalMs` | `CCW_MIN_INTERVAL_MS` | `1000`；1–600000，约束实际提交间隔 |
| `backend` | `CCW_BACKEND` | `web`；`web` 只用网页，`api` 只用备用 API，`auto` 对新别名先预检网页 |
| `apiBaseUrl` | `CCW_API_BASE_URL` | `null`；必须 HTTPS（仅 loopback 测试允许 HTTP），不带凭据、query 或 fragment |
| `apiModel` | `CCW_API_MODEL` | `null`；配置的提供商标识优先；否则从宿主目录动态选择最新 Claude Opus，别名创建后固定 |
| `apiKeyFile` | `CCW_API_KEY_FILE` | `null`；密钥文件绝对路径，须属当前用户、非链接、`0600`、≤ 8 KiB |
| `apiMaxTokens` | `CCW_API_MAX_TOKENS` | `2048`；1–65536，每次请求的输出上限 |
| `apiContextTokens` | `CCW_API_CONTEXT_TOKENS` | `16000`；1024–131072，输入历史的保守估算预算 |
| `apiProtocol` | `CCW_API_PROTOCOL` | `messages`；`messages`/`chat`/`responses`，别名创建后固定 |
| `apiCache` | `CCW_API_CACHE` | `ephemeral`；Messages 消息前缀断点，`off` 不发送断点；Chat/Responses 使用服务端自动缓存 |
| `apiReasoning` | `CCW_API_REASONING` | `off`；`low`/`medium`/`high`/`xhigh`/`max`；Chat/Responses 另接受 `none`/`minimal`，支持范围取决于模型 |

仅已定义的环境变量覆盖配置字段；未定义值不清除文件配置。根在启动时解析并固定，工具参数不能重定向；修改配置后须重启 MCP/重新加载插件。部分宿主（Codex 默认即如此）会过滤自定义环境变量，原生插件也不支持任意 `${ENV_VAR}` 展开，因此不要仅在启动宿主前 `export CCW_ATTACHMENT_ROOT` 就假定 MCP 已获得它。普通安装和插件都应使用上述配置文件；安装器不改写它或客户端的环境转发策略。`claude_doctor` 会在 `attachments` 中报告附件能力是否已配置及来源；该诊断不返回批准根的实际路径。

当调用显式携带附件而启动时没有批准根，桥接会在浏览器、远端会话和 `pending` 状态产生前返回 `ATTACHMENT_SCOPE`。这是有意的前置授权拒绝，不应通过创建一个之后必然失败的待确认请求来伪装成可恢复发送。请由操作者写入 `attachmentRoot` 后重连桥接；不要静默去掉附件、自动选根或改走备用文本通道。

### 浏览器发现

`cdpUrl` / `CCW_CDP_URL` 显式指定时永远优先。未指定时，桥接只读枚举本机 Chrome/Chromium 主进程：接受显式 `--remote-debugging-port`，或读取该配置根中由浏览器生成的 `DevToolsActivePort` 获得动态端口；忽略 helper 子进程、非 loopback 地址、不可达端点和未登录 Claude 页面。若恰有一个已登录候选则自动使用；无候选返回 `BROWSER_NOT_FOUND`，多候选返回 `BROWSER_AMBIGUOUS` 并要求显式配置。该过程不启动或重启浏览器、不扫描任意端口、不读取 cookie 或浏览器存储。

宿主模型目录只读扫描支持的宿主与 Magpie 配置根，每个宿主最多 64 个允许名称的配置文件、3 层深度、单文件 2 MiB；排除凭据、缓存、历史、备份、hooks、浏览器存储和依赖目录，只返回模型标识及系列，不返回其他配置内容。

## 命令

| 命令 / 工具 | 行为 |
|---|---|
| `doctor` / `claude_doctor` | 连接浏览器并做一次**只读**组织请求。能区分“连不上 CDP”“未登录”“组织/协议不符”；备用通道启用时另报 `backend: api` 与 `api.credential.readable`（只本地校验密钥文件，不发请求）。不证明下一次发送会成功。 |
| `ask` / `claude_ask` | 新建远端会话并发送首轮。`session` 是本地别名；`title` 默认 `[ccw] <session>`；`model` 只在首轮生效；`guidance` / `--guidance` 在缺失标记时追加固定块。 |
| `follow-up` / `claude_follow_up` | 在同一服务端分支末尾追加一轮。存在 pending 时拒绝（`PENDING_TURN`）；`guidance` 语义同 `ask`。 |
| `sessions` / `claude_sessions` | 列出本地别名与 pending 状态；不触碰浏览器。 |
| `transcript` / `claude_transcript` | 读取服务端当前分支（含 `recover` 显式对账）；服务端无新轮次时，`recover` 可核对并补完成一次原生 held draft（结果标 `resumed`）；`--discard-pending` 显式放弃无法对账的 pending 并把原生别名重锚到当前服务端 leaf（结果标 `discarded`），备用 API 别名返回本地历史，`discardPending` 需与 `recover` 同时使用。 |
| `api-bind-credential`（仅 CLI） | 校验旧密钥后绑定已配置的新密钥；无身份记录的旧历史只能显式接管，不发送请求。 |
| `native-resume`（仅 CLI） | 对 `pending: upload` 或 `pending: send` 的原生会话，先核对原问题的 canonical 摘要，再核对浏览器草稿与已记录的上传 ID 后只提交一次；摘要不符、ID 未知或旧 PDF 草稿均拒绝提交并保留 pending。`send` pending 草稿已被点击消耗时，纯文本轮次可重新填入原文提交，带附件轮次要求页面仍持有全部附件芯片。 |
| `download` / `claude_download` | 按当前会话产物 ID 刷新元数据并回拉文件；不发送新消息，备用 API 别名不支持。 |
| `unlock` | 仅在锁属主进程已死（同主机、ESRCH）时移除状态锁；`--session NAME` 释放该别名锁。 |

### 模型选择

新网页别名未指定 `model` 时，优先取宿主模型目录与网页可访问模型目录的交集，并选择最新 Claude Opus；显式模型必须在网页菜单中可见，切换后会以创建回执和发送回读双重确认。备用 API 新别名优先使用启动方配置的 `apiModel`；未配置时从宿主目录选择最新 Claude Opus，显式 `model` 使用目录中的提供商标识。网页显式模型优先级不受 `CCW_API_MODEL` 影响。两种通道的旧别名都固定原模型，追问不接受 `model`。

`doctor` 只读展示 `model.catalog`（宿主目录）、`model.webpage`（当前网页控件与可见模型）和 `model.selection`（当前规则会选的模型）。网页目录读取失败会保留错误码；这不代表可发送，更不证明真实模型语义已通过 live 验收。

### 模式前缀 web / api

`ccw web <command>` 与 `ccw api <command>` 在调用点强制选择后端，覆盖配置文件与 `CCW_BACKEND`，且**永不回落**：

```bash
ccw web follow-up --session file-review --prompt "按网页通道继续"
ccw api ask --session topic-api --prompt "纯文本问题"
```

- 显式模式不触发 `auto` 的只读网页预检；`api` 端点或密钥不完整时直接报 `API_NOT_CONFIGURED`。
- 别名已被另一后端占用时返回 `MODE_MISMATCH`；`details.backend` 是实际归属，`details.requested` 是请求模式。不会静默按归属改路。
- 不带前缀的 `ccw <command>` 仍按配置的 `backend`（`web` / `api` / `auto`）执行。MCP 工具与原生插件没有模式前缀，由启动配置决定。
- `api` 模式只发文本，拒绝 `--attach` 与 `--native`；`download`、`native-resume` 只在网页通道可用。

## 显式附件与回拉

```bash
ccw ask --session file-review --stdin \
  --attach /absolute/approved-files/sample.png \
  --attach /absolute/approved-files/sample.js
ccw follow-up --session file-review --prompt "根据上一轮附件核对结果"
ccw transcript --session file-review
ccw download --session file-review --artifact RETURNED_ID --destination result.js
```

第一条命令从 stdin 读取问题；路径必须由用户明确选定。`--attach` 逐个重复，不能用 glob、目录或 URL；`--file PATH` 仍只读取问题文本，绝不能拿它绕过禁仓库边界。没有输入附件但希望 Claude 生成文件时，发送前加 `--native`。

MCP 的 `claude_ask` / `claude_follow_up` 可增加 `attachments: ["/absolute/approved-files/sample.js"]`、`native: true` 和 `guidance: true`；不接受嵌套文件对象、工具自报的授权根或未知字段。`claude_download` 参数为 `session`、`artifact` 和可选 `destination`，原五工具的纯文本调用兼容。

- 上传只开放 PNG、UTF-8 `.js`，`.pdf` 附件会在访问浏览器前拒绝，带 PDF 文件头的伪装代码文件也会在上传前拒绝：最多 5 个，单个最多 2 MiB，总计最多 4 MiB，代码文本另限 64 KiB。不读取 import、邻接文件或 Git 历史；拒绝归档、目录、链接和根逃逸。禁止拼接、改名、压缩或拆批上传整仓，这是调用方也必须遵守的边界，不能声称类型检查能识别任意隐藏内容。
- 图片必须取得可核对的上传身份和就绪状态；代码经网页提取文本附加。不就绪、处理失败、取消或超限，不改成只发文字，也不自动重传。追问复用远端上下文，仅附新增且获授权的文件。
- 图片回执只拦截本组织 `/upload` 的 `Fetch` 响应，不依赖全页网络缓存。回执就绪后，在 `readyTimeoutMs` 内只读等待浏览器草稿的类型、大小、上传 ID 和正文核对通过。只有真正表示「还没落盘」的状态可重试：草稿整行缺失（`UI_DRAFT_UNAVAILABLE`）与 `blob` 占位（`FILE_NOT_READY`）；大小、类型、上传 ID 不同或草稿含外来正文属永久冲突，首次读取即报 `UI_DRAFT_CONFLICT`，不会白等一个超时。超时仍保留原错误及 `pending: upload`。上传重定向会中止；响应释放失败不允许继续提交，并把原始上传错误保留为 `cause`。
- 回复和 transcript 的 `artifacts` 提供与会话、消息及版本绑定的标识，不是任意外链。公开聊天文件交付可回拉；Frame Artifact 仅当同一回复中紧接 `Write` 之后单文件首次发布、且页面为 LF 换行纯 ASCII 时 `downloadable` 为 `true`，回拉该次写入的页面原件（`text/html`，默认 `index.html`，绑定发布版本）。其余 Frame（含中文等非 ASCII 字符、CR 或 BOM 的页面）的 `downloadable` 为 `false`，下载报 `FRAME_EXPORT_UNVERIFIED`；查看页渲染的是注入运行时后的预览，不是原件。不改变分享权限，不提取 PDF/Word 内嵌素材。
- 单次原件最多 2 MiB。默认文件名来自产物；可指定根内相对路径，父目录必须已存在，且归当前用户、不可由组/其他用户写入。拒绝路径穿越、链接、重定向、异源、登录页和已识别的错误体；不会覆盖已有文件。
- 成功结果含 `artifact`、`path`、`mimeType`、`sourceMimeType`、`size`、`sha256`，不返回 base64。服务端可能没有 MIME 头；仅已知且通过内容校验的格式可推断 `mimeType`，此时 `sourceMimeType` 为 `null`。下载只是取回不可信字节；还须本地核对内容与预期，不自动打开、解压、执行或把产物当作新授权。
- 中断只清理本次仍可证明归属的半成品。`cleanupPending: true` 时保留并上报核对位置，不删除替换文件；`published` 表示目标可能已经落盘，先检查，不要覆盖或盲目重试。

本轮文件系统验证在 macOS 进行；其他系统未实测，缺少所需安全文件系统原语时拒绝文件操作。离线假服务验证不等于真实 Claude 读取或理解了文件。

当前实现验收：三个聊天原件已由桥接回拉，并与网页原生基准逐字节对照。一次复用恢复草稿的真实提交中，Claude 正确读取了 PNG 和 JS；移除 PDF 输入后的独立自动上传流程尚未重新进行真实验收。`scripts/smoke-attachments.mjs` 缺省只返回 skipped，不读取文件或连接浏览器；真实模式仅适用于已获准的合成样本、既有测试会话和预算账本，`--live` 本身不授予权限。

2026-11-06 补充核验：`Fetch` 取得一份 608,203 字节合成 PNG 的上传 ID；遇到草稿 `blob` 占位后，通过显式 `native-resume` 复用已上传文件和原提示词完成一轮，`complete: true`、`pending: null`，未重复上传。草稿落盘等待的修复已通过真实桥接入口的离线回归，但该次恢复提交不能替代修复后独立自动上传全链路的 live 验收。中文产物虽已生成，原件字节仍未核实，继续拒绝下载。

## 备用 API 通道（可选）

`backend=api|auto` 时可选择 HTTP Messages、Chat Completions 或 Responses 兼容端点。`apiProtocol` 默认为 `messages`，另外两种值是 `chat` / `responses`。它**只发文本**，与网页通道共用别名登记，但状态、历史、锁和密钥完全独立。

- **推理字段按协议发送。** Messages 使用 `thinking: {"type":"adaptive"}` + `output_config.effort`，Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`。三者都接受客户端强度 `low` / `medium` / `high` / `xhigh` / `max`，后两者另接受 `none` / `minimal`；具体模型可能不支持全部档位，不自动降档。`off` 只省略字段、使用模型默认，不等于关闭思考。三种协议都把 `apiMaxTokens` 作为严格输出硬上限，按协议发 `max_tokens` / `max_completion_tokens` / `max_output_tokens`；推理消耗也计入该预算，达到上限会保存 `complete:false`。默认值为 2048，`apiMaxTokens` 可配 1–65536。`ccw doctor` 的 `api.protocol`、`api.request.path` 和 `api.request.fields` 显示同一套实际载荷装饰；`api.reasoning` 另显示等级与配置值。
  已知限制：effort 是否生效取决于网关，返回 200 不能证明这一点。2026-11-05 三协议 low/max 六次探针都通过，但 Messages 报思考用量为0，Chat/Responses 未提供该详情，所以不能判定哪种协议更有效。失败返回 `API_HTTP_ERROR` 和状态码，不带响应正文、不重试、不静默降档，别名保留 pending。发送总时限最多600s，SSE 保活不延长总时限，超时同样可能已计费；放弃 pending 必须显式 `ccw transcript --session NAME --recover --discard-pending`。各协议字段和限制详见本节。

- **自动选择只在发送前发生，且只针对新别名。** `auto` 先做一次只读网页预检（`/api/organizations`，不创建会话、不发消息）。预检失败且备用通道已配置时改用 API；预检成功、别名已存在、参数校验失败、被取消，或任何已经开始的发送失败，都不会切换通道。`api` 模式不预检浏览器；`web` 模式永远不碰 API。
- **粘性会话与滚动窗口优先。** 别名创建时固定本地会话身份（服务端 `metadata.user_id` 与 `x-session-affinity` 使用同一 UUID）、端点、模型与协议；本地保存完整文本历史，发送时按完整 user/assistant 轮次选取同时满足估算 token 预算和实际 JSON 256 KiB 上限的最新后缀，跨 CLI / MCP / 插件进程一致。结果的 `context` 明确报告估算 token、实际字节以及保留/省略轮数；省略只影响请求载荷，不裁剪持久化历史、不自动摘要。旧别名始终使用已存模型，不迁移动态默认；非显式选模旧别名在配置另有 `apiModel` 且与已存模型不同时报 `API_PROFILE_CHANGED`，显式 `--model` 别名不随后续 `apiModel` 变化而重绑。改变 `apiBaseUrl` / `apiProtocol` 仍要求新别名。旧历史未记录协议时按 `messages` 读取。`apiMaxTokens`、`apiContextTokens`、`apiReasoning` 和 `apiCache` 是每次请求的装饰，不更换会话；Chat/Responses 发 `store:false`，不建立服务端 response 链。
- **会话并发只放宽到不同别名。** 同一别名由 alias 锁串行发送/恢复，并由 durable pending 保留中断证据；不同别名的网络请求并发执行，状态写入只在短暂互斥事务中重读并合并，不再长期持锁。没有全局会话并发上限，实际吞吐受端点、凭据、模型与进程资源约束。
- **凭据变化先停止。** 每个新 API 别名保存独立盐值和 scrypt 校验值，不保存密钥；当前密钥不匹配时返回 `API_CREDENTIAL_CHANGED`，不会重放历史。按原端点配置新密钥后，使用 `ccw api-bind-credential --session NAME --old-key-file /absolute/private/old-key`，由私有旧密钥文件验证后迁移；改绑与发送/恢复受同一 alias 锁串行，存在 pending 时不能迁移。旧版历史没有凭据校验值，保持可读，但继续发送会报 `API_CREDENTIAL_UNBOUND`；只有操作者明确接受身份无法验证，才执行 `ccw api-bind-credential --session NAME --adopt-unbound`。两种命令都不发请求，也不证明服务端账户身份。
- **历史有界且私有。** `api-sessions.json` 与 `sessions.json` 同目录，单独加锁（`api.lock`）、`0600`、原子写入、拒绝链接/他属/组或其他用户可读的文件。上限 20 轮或 256 KiB 上下文，按 `API_CONTEXT_LIMIT` 停止，不裁剪、不总结、不重建。发送载荷另受 `apiContextTokens` 的保守估算和实际 JSON 字节双重约束；当前 prompt 单独超 token 预算返回 `API_INPUT_BUDGET`，单独超 JSON 字节返回 `API_CONTEXT_LIMIT`，都不写 pending、不发请求。正文只存在该文件，不写日志、不进仓库。
- **Messages 使用 SSE，另外两种协议保持 JSON。** Messages 发 `stream: true`、收 `text/event-stream`，逐块排除思考/签名，`message_delta` 的累计 usage 覆盖已给字段、保留 message_start 中未被后帧提供的值，`message_stop` 才确认终止。截断终止保留 `complete:false`；没有完整终止事件的断流报 `API_STREAM_INCOMPLETE`，不保存 partial delta。CLI/MCP 仍只在完成后返回一个 JSON，不逐 token 输出给调用方。ping/delta 可缓解部分空闲超时，不能解决 429 或保证不会 524；协议不符不降级/重发。
- **整流器：每轮默认只发一次 HTTP 请求。** 发送前先落盘 `pending`；流式 error、断流、超时、中断、网络错误或落盘失败都保留 pending，返回 `pending: true`、`retried: false`。重定向、认证失败、协议/契约错误、取消和不确定结果一律不重试。只有操作者已明确确认端点 POST 幂等时才允许有界重试；当前配置未确认，`doctor` 报 `transport.idempotencyConfirmed: false`。若回复到了但历史写不进去，返回 `API_STATE_IO` 且 `responseReceived: true`，绝不重发。
- **备用通道没有服务端权威历史。** `transcript` 的 `recoveryAvailable` 为 `false`：`recover: true` 只把 pending 标为 `reconciliation.status: "unconfirmed"`，既不清除也不重发。用户明确决定放弃该次尝试时，在同一个 `recover` 调用里加 `discardPending: true`（CLI `--discard-pending`）；此后再次发送就是一次新的计费请求。恢复失败不能当作"原请求没发出去"的证据。
- API 历史文件上限为 2 MiB；发送前预留最坏情况下回复及 JSON 转义所需空间，余量不足返回 `API_STATE_CAPACITY` 且不发请求。超过旧 512 KiB 但未超过新上限的合法历史可直接读取；文件已超过新上限时返回 `API_STATE_TOO_LARGE` 并保留原文件供备份和检查，不自动重置或裁剪。
- **如实汇报用量。** `usage` 将各协议计数归一为 `inputTokens` / `outputTokens` / `cacheCreationInputTokens` / `cacheReadInputTokens` / `reasoningTokens`，缺失时为 `null`，明确的 0 不冒充未知。Chat/Responses 缓存由服务端自动管理，`apiCache: off` 只控制 Messages 断点，不能关闭服务端自动缓存。`cache` 仅汇总实际观察到的命中；本项目不计算金额或节省比例，稳定的本地会话 ID 也不证明服务端账户固定或强度生效。
- 不迁移网页历史或附件，不支持上传、产物下载和 `native`；`download` 对 API 别名返回 `API_UNSUPPORTED_INPUT`。不把 API 回复、模型名或用量当作已核验事实。

示例（密钥放在应用私有目录，命令行只引用路径）：

```json
{
  "backend": "auto",
  "apiBaseUrl": "https://api.example.com",
  "apiKeyFile": "/absolute/private/key"
}
```

```bash
CCW_API_MAX_TOKENS=256 ccw ask --session topic-api --prompt "synthetic probe"
ccw follow-up --session topic-api --prompt "second turn"
ccw transcript --session topic-api --recover
ccw transcript --session topic-api --recover --discard-pending
```

协议兼容性、模型真实性和服务端会话亲和需由启动方自行实测；本地假服务只验证请求形状、状态机和安全边界。

## 超时与取消

- `CCW_TIMEOUT_MS`（默认 600s）用于一次公开网络操作，包括 download；`CCW_IDLE_TIMEOUT_MS`（默认 120s）限制请求无数据或原生会话无进展的等待。SIGINT/SIGTERM/MCP 输入关闭会取消在途工作、释放锁，并清理仍属于本次操作的标签页和临时文件。为确认 target 所有权、处理清理，取消后可能有额外的有界等待。
- MCP 注册建议 `tool_timeout_sec=660`（安装器已按此配置）。

## pending 与恢复（重要）

发送前持久化 `pending`，不存问题正文。旧 REST 只有收到有效的 `message_stop` 才清除；原生通道还要核对服务端当前分支、问题和附件身份。响应的 `complete: false` 表示已终止但内容截断，`stopReason` 保留原因；`complete: null` 表示未知。后续调用的 `previousComplete` 保留上一条状态；明确追问是新一轮发送，不是对不确定发送的重试。旧 API 历史未记录完成态时显示 `null`。

- `PENDING_TURN`：上次发送结果不确定。**不要重发同一问题**。先 `claude_transcript` 读服务端历史；只有需要接续时才用 `recover: true`。
- `recover` 的清除条件：原父节点仍在当前分支，后缀恰为 `[human, assistant]`，问题摘要一致；原生附件还须匹配原上传 ID、名称、大小、类型及代码文本摘要，完整清单也须匹配。assistant 须有可识别的终止原因；已终止的截断回复仍可对账，但保持 `complete: false`。原生回复须有文字或有效公开产物；旧文本通道须有非空文字。
- `pending.kind === 'send'`（`transport: 'native'`）且服务端分支在父节点后没有任何新轮次时，说明已填正文可能仍留在标签页输入框而未点击发送：`recover` 会在浏览器里只读核对草稿正文摘要与全部附件身份，全部命中时在该会话上替用户完成这一次未发送的提交（不重发、不新起一轮），再等出回复并清除 pending；正文或附件被改动、分支已动或页面不可核对时报 `UI_DRAFT_CONFLICT`/原错误并保留 pending 与标签页。新标签页从 IndexedDB 异步恢复草稿时会在有界窗口内重读，编辑器刚挂载前的空文本不会误判为冲突。纯文本轮次在正文进页面前就已落盘 `send` pending，所以这一类中断不再有"无恢复入口"的死锁。
- `pending.kind === 'send'` 且 `recover` 无法核对草稿时（草稿被消耗、被改或页面不可核对），`native-resume` 是显式逃生通道：同 `upload` pending 一样核对原问题摘要与附件身份后只提交一次，正文已被消耗时可重新填入原文，附件芯片缺失则不重传、不提交。
- `user_canceled` 的 assistant 视为已终止：服务端已落 human 即证明发送发生，`recover` 可对账清除 pending，`complete: false` 表示已终止但内容不完整；后续 `follow-up` 允许以该取消 leaf 为父节点。
- `recover --discard-pending` 是最后的显式放弃通道：只读服务端当前分支，清除 pending 并把 `parentMessageId` 重锚到当前 leaf（空分支则回根），结果标 `discarded: true`；不发送、不重发原 prompt。分支已被用户在网页上继续编辑、草稿无法核对或原正文不可得时使用；放弃意味着该次发送不再接续。
- 用户草稿、剩余附件或无法检查的页面会保留；结果或错误中的 `browserCleanup.closeUnconfirmed` 标明目标关闭未获确认。创建目标超时或取消但尚无回执时，`cleanupPending` 表示可能有残留；迟到回执仅在目标归属及空白状态可确认时清理，仍不能由此保证后续清理成功。`auto` 模式的网页预检若有清理风险，会在后续结果或错误的 `webPreflightCleanup` 中保留该信息。
- `pending.kind === 'upload'` 或身份缺失不能证明已经发送/完成；保留 pending，请用户处理，不自动重传或改用其他通道。原生发送把 CRLF 规范为 LF 并裁剪首尾空白，再核对网页回读。
- 简短/空历史**不能**证明请求没发出去；无法证明完成时报告现状并保留会话。
- `pending.kind === 'create'`：仅当服务端会话存在且为空时清除，允许之后从根发首轮；不补发任何请求。

## 复用已恢复的原生草稿

上传或发送过程不确定时（`pending.kind === 'upload'` 或 `pending.kind === 'send'`），浏览器可能仍持有附件草稿，或草稿已被点击消耗。只有原 pending 已记录所有二进制文件的上传 ID，才可用显式命令复用该草稿；缺失 ID 时返回 `FILE_NOT_READY` 并保留原状态，不自动重新上传。`send` pending 走同一条显式路径：服务端无该轮记录、操作者确认这次提交确实没发出去时，由它完成这一次未发送的提交；不核对服务端是否"真的没收到"，那是 `transcript --recover` 的职责。

```bash
ccw native-resume --session NAME --file /absolute/private/original-prompt.txt
```

`--file` 必须提供经授权保留的原发送正文；它是文本文件，不会被当作附件上传。提交前以网页规范化规则（CRLF/CR→LF，裁剪整段正文首尾空白）核对该正文的 SHA-256 与原 `pending.promptSha256`；不符返回 `PROMPT_MISMATCH`，不打开浏览器、不改 pending、不发送。原发送使用 `--guidance` 且**当前契约仍与当时相同**时，可传原始问题加 `--guidance`；追加发生在规范化之前，原始问题末尾的空白也会影响最终摘要。契约升级后相同开关可能得到不同正文，应提供原次完整正文并不加 `--guidance`。若原次正文不可确定，不要猜测、重发或改别名，保留 pending 并先只读对账。

新发送拒绝包含孤立 UTF-16 代理项的非规范 Unicode。旧 pending 的 UTF-8 摘要无法区分原本的替换字符 `U+FFFD` 与孤立代理项；恢复正文含 `U+FFFD` 时，不论草稿是否已填都在打开浏览器前返回 `PROMPT_IDENTITY_AMBIGUOUS` 并保留 pending。这也会拒绝合法的 U+FFFD 原文，包含该字符的新附件请求若上传中断，同样无法自动恢复草稿。旧服务端历史对账仍保持兼容，但只能证明 UTF-8 字节等价，不能证明旧输入的原始编码身份；不确定时停止，不重发。

执行顺序与保护：

1. 只处理 `pending.kind === 'upload'` 或 `pending.kind === 'send'` 且 `transport === 'native'` 的会话；没有 pending、pending 是 `create`，或旧清单含 PDF 等不支持的附件时直接拒绝并保留原状态。核对原问题规范化摘要，不符时报 `PROMPT_MISMATCH`。
2. 核对服务端当前分支仍是原父节点，否则 `REMOTE_BRANCH_CHANGED`，不提交。
3. 读取浏览器已恢复的草稿（只读）：标签上的文件名必须与原清单完全一致，二进制文件的服务端 ID 必须与原记录一致，文本附件的内容摘要与大小必须与本地原件一致，草稿中不能出现清单之外的附件。已有正文只能与本次显式传入的规范化 prompt 完全相同（兼容网页双换行展示）；其他文字仍返回 `UI_DRAFT_CONFLICT`。整行缺失与 `blob` 占位会在 `readyTimeoutMs` 内重试，其他永久身份不符立即报 `UI_DRAFT_CONFLICT`；任何等待失败都保留页面供检查，不提交、不清理草稿。
4. 正文为空时填充，相同正文则原样复用、不重复输入；随后在同一个预算内再次等待草稿身份通过，并复核远端父节点，一致时先落盘 `pending: send`，再只点击一次发送，然后核对父链与附件身份。第 3、4 两步各等待一次，因此恢复路径最坏总等待为 2 × `readyTimeoutMs`（正常发送为 1 ×）；第二次通常首个轮询即通过。页面检查与点击并非原子操作，只能证明点击前最后一次观察一致。

该命令只通过 CLI 提供，不注册为 MCP 工具：它会复用一份属于操作者的浏览器草稿，应由用户显式发起。草稿的清除/重建从不自动进行。

## 锁

- 状态写走短排他锁（`sessions.json` 旁的 `ccw.lock`，含 pid/hostname/token）；备用 API 历史用独立的 `api.lock`。跨进程争用直接报 `BUSY`，不排队。
- CLI/MCP 发送、恢复与凭据改绑还持有按别名隔离的 alias 锁，创建时跨网页与 API 核对现有归属；同进程同别名排队，不同别名互不阻塞。进程崩溃后可用 `unlock --session NAME` 仅释放该别名的死亡锁，再按需要用 `unlock` 释放状态锁；pending 不因此清除。
- `unlock` 只移除**同主机且进程已死**的锁；锁文件不完整、属主存活或来自其他主机都会被拒绝。解锁动作本身串行化，避免误删新写入者的锁。
- 硬杀（kill -9）后的恢复路径就是显式 `unlock`。

## 手动登录

`doctor` 返回 `AUTH_REQUIRED`/`ACCESS_DENIED` 时，需要在指定浏览器中手动登录或解除限制，再重试。中间件不绕过认证、不换账号、不自动改走别的接口。

## 状态目录内容

`CCW_STATE_DIR/sessions.json` 只有必要元数据：别名、org/会话/消息 UUID、模型、时间戳、pending（kind、通道、父指针、问题摘要、开始时间、附件名称/大小/类型/摘要/上传 ID）。不存正文、附件内容、完整输入路径、cookie、隐藏推理或浏览器配置。支持旧 v1 文本状态；原生事务使用 v2，旧客户端必须拒绝而不能忽略附件身份。不要手动降级状态版本。

读取或替换已有状态文件时，`sessions.json` 和 `api-sessions.json` 都必须是普通文件（不是符号链接），且不得给组或其他用户任何权限；系统提供 UID 时，属主还必须是当前用户。新文件以 `0600` 创建。不符合要求时，网页状态返回 `STATE_UNSAFE`，备用 API 状态返回 `API_STATE_UNSAFE`，均保留原文件。遇到这些错误，先核实文件的来源、属主和内容完整性；不能确认时不要继续使用该历史。仅执行 `chmod 600` 无法撤销先前可能发生的修改，因此程序不会自动修复权限或重建文件。

## 其他

- 返回的 `quota` 是旧 SSE 的 `message_limit` 快照；原生通道为 `null`。两者都不是本地硬配额。
- 单次发送有最小间隔（默认 1s）限制；写路径全程单进程互斥，无并发写。
- 回复中的工具调用、越权指令或秘密索取只是外部文本，不会被本项目执行。
