# Release 安装

[English](install.en.md) · [使用说明](usage.md) · [LLM 安装协议](../llms.txt)

## 边界和前置条件

- macOS/Linux、Bash、Node.js >=22，且 `node` 在 PATH 上可用；无需 Git、npm、clone 或管理员权限。Windows 的 Bash 安装未验收。安装器生成的命令和直连宿主注册只保存稳定的 `node` 命令名，不保存 Homebrew/nvm 等版本化物理路径。
- 开发仓库只用于开发、测试和构建，不能作为生产 CLI/MCP/技能的消费场所。根目录 `install.sh` 是拒绝源码消费的构建模板；只执行 Release 资产里的同名脚本。
- 从项目**私有 Gitea Release** 页面选择固定版本；下载 `install.sh`、`SHA256SUMS` 和 `claude-web-api-v版本.tar.gz`。本地构建不等于远端已发布，不能仅凭 package 版本或本文推断下载链接存在。GitHub 不是默认发布源。
- 使用可信 Release 页面提供的摘要。SHA-256 证明传输完整性，不替代发布者身份、签名或代码安全审查。不执行未经校验的脚本，不使用 `curl | bash`。
- 明确授权安装位置和接入方式。Bash 仅部署运行时，不修改宿主、Magpie Library、shell 启动文件、浏览器配置或会话状态，不自动发送 Claude 消息。

## 已下载资产：校验并预览

运行目录：保存上述三个资产的目录，不是源码目录。先把环境变量 `CCW_VERSION` 设为 Release 页面已确认存在的固定版本（无 `v` 前缀）。以下命令先验证 Bash 和归档，再做**不创建目录、不加锁、不下载**的预览：

<!-- verify:release-local-preview -->
```bash
: "${CCW_VERSION:?先选择一个已发布的固定版本}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi
ASSET="claude-web-api-v${CCW_VERSION}.tar.gz"
DIGEST="$(awk -v name="$ASSET" '$2 == name { print $1 }' SHA256SUMS)"
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST" --dry-run
```

成功观测：两份资产摘要通过，JSON 包含 `ok:true`、`dryRun:true`、`artifactVerified:true`。失败时停止；不要跳过校验或改用源码。多条/缺失摘要也不能当作通过。

## 安装和文件级验证

保持同一目录和上述变量，在获得写入授权后执行：

```bash
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST"
bash ./install.sh --status
"$HOME/.local/bin/ccw" --help
"$HOME/.local/bin/ccw" --status
```

安装成功返回 `ok:true`、指定 `version`、`registeredHosts:false`；重复安装相同字节返回 `changed:false`。`install.sh --status` 与 `ccw --status` 都只读核验所有已安装文件、权限与命令归属，返回 `verification:"installed-files-and-commands"`；这不证明浏览器或实际宿主已加载。已安装时 `binDir` 始终报告归属记录中实际核验的目录，未安装时才使用传入或默认的显示目录。

有实际变更的安装或回滚会在运行根写入 `reconnect-required` 标记；`--status` 输出 `reconnectRequired:true` 与 `reconnectVersion`。两种 `--status` 只接受有界、单链接的普通 marker 文件；符号链接、目录、超大文件或读取期间变化的 marker 一律以 `UNSAFE_PATH` / `CONCURRENT_CHANGE` 拒绝。直连宿主经 `ccw-hosts --check --probe` 全绿核验（配置归属已核对且有界 initialize/tools/list 可达当前版本）后，该标记才被清除，`--status` 恢复 `reconnectRequired:false`；`changed:false` 的幂等安装不产生也不清除标记。绿色 probe 输出还报告 `reconnectCleared` 与 `reconnectMarker`（`cleared` / `absent` / `failed` / `no-release-root` / `not-current-release` / `not-attempted`）；进程内开发调用无版本化运行根时明确显示 `no-release-root`，不再静默跳过。`reconnectMarker` 为 `failed`/`no-release-root`/`not-current-release` 时顶层额外返回 `warning` 字段提示清除未完成；`cleared`/`absent`/`not-attempted` 不出现 `warning`。

默认布局：

```text
~/.local/share/claude-web-api/runtime/
  install.json              # 私有归属、版本摘要与命令摘要
  releases/v版本/            # 不可变程序、技能、文档和 release.json
  current -> releases/v版本
  previous -> releases/v上一版本
  reconnect-required        # 存在即提示宿主尚未按新版本重连核验
  backups/                  # 配置前/后像与恢复日志（不是会话备份）
~/.local/bin/ccw              # CLI
~/.local/bin/ccw-mcp          # stdio MCP
~/.local/bin/ccw-hosts        # 明确选定的直连宿主注册器
```

会话仍在原状态目录，凭据/附件根不被修改。可用 `--prefix /绝对/运行根 --bin-dir /绝对/命令目录` 选择其他仓库外目录；以后升级、状态和回滚必须继续传同一个 `--prefix`。`--bin-dir` 不能位于运行根内部，不能无声迁移已安装命令。使用完整命令路径即可，无需修改 PATH；但 `node` 自身必须始终在消费进程与宿主启动进程的 PATH 上。

## 已验证脚本：从 Release URL 自助下载

运行目录仍为校验过脚本的目录。`CCW_RELEASE_URL` 必须由操作者给出，形如可信私有 Gitea 的 `https://…/owner/repo/releases/download/v版本`，不带凭据、query 或 fragment；不能猜 GitHub 镜像或切换来源：

```bash
: "${CCW_VERSION:?选择固定版本}"
: "${CCW_RELEASE_URL:?提供对应的 HTTPS Release URL}"
bash ./install.sh --version "$CCW_VERSION" --release-url "$CCW_RELEASE_URL" --dry-run
bash ./install.sh --version "$CCW_VERSION" --release-url "$CCW_RELEASE_URL"
```

远端预览**不联网**，返回 `artifactVerified:false`，不证明资产可下载。实际安装才读取 SHA256SUMS、下载并验证归档。私有 Gitea 下载必须由启动环境显式注入 `CCW_RELEASE_TOKEN`；安装器不调用 Git credential helper，也不做隐式凭据回退。发布脚本 `scripts/publish-gitea-release.mjs` 的 `--credential-helper` 是独立的显式 opt-in 回退：仅当无 `CCW_RELEASE_TOKEN`/`--token-file` 时，经 `git credential fill` 取凭据，限时 5 秒且 token 不打印。不要把真实值写进命令、URL、文档、日志或 shell 历史，不用 `set -x`/环境转储查看它。认证错误停止，不索要密码。

同源重定向最多 5 次，跨源跳转拒绝，不把令牌发给对象存储或其他主机；需要跨源存储时通过已授权页面下载资产并走离线校验。单资产默认 30 秒，可用 `--timeout-ms` 在 500–120000 ms 内调整；不自动重试或降级到源码。

## 选择一种宿主接入方式

### 已有 Magpie 或其他管理器

保留原来的管理器归属，不再额外注册一条直连。先保存/核对原条目，在现有 `claude_web` 定义中把 command 改为下列命令打印的**绝对路径**，args 为空数组；技能入口指向独立运行根 `current/skills/claude`，不能使用开发目录。仅复制或导入技能目录并不会生成 `runtime.json`：这样的副本无法可靠使用技能内 `scripts/ccw.mjs` CLI 回退，须使用下列独立的稳定 `ccw` 命令；不得把复制成功当作技能已绑定。不能把 `~` 字面量当作程序路径：

```bash
printf '%s\n' "$HOME/.local/bin/ccw-mcp"
printf '%s\n' "$HOME/.local/bin/ccw"
printf '%s\n' "$HOME/.local/share/claude-web-api/runtime/current/skills/claude"
```

只在取得管理器配置修改授权并确认无在途调用后，通过该管理器的受支持入口更新并重连。不要编辑 hub 缓存或盲目重启整个 Magpie。无法确认草稿、活动调用或归属时保留现状并报告。

### 已确认无外部管理器的直连宿主

例如明确确认 dsh 由本项目安装记录管理后，先预览再注册；不要照搬宿主列表批量安装：

```bash
"$HOME/.local/bin/ccw-hosts" --list
"$HOME/.local/bin/ccw-hosts" --host dsh --dry-run
"$HOME/.local/bin/ccw-hosts" --host dsh
"$HOME/.local/bin/ccw-hosts" --check --host dsh
```

`ccw-hosts` 包装产物内部的 `scripts/install-agents.mjs`，注册值和 `runtime.json` 均应指向独立 `runtime/current`，不得指向源码或 dist。从 `releases/v版本` 目录直接调用内部入口或 bundle 会被拒绝；显式解压的非安装目录仍可按原方式注册。普通 `--check` 分别报告 `magpie-hub`、`magpie-direct`、`external-direct` 和本安装器来源；已核对外部入口 `configured:true`、`installed:false`，安装时跳过而不重复注册，并只读报告外部技能副本相对当前运行时的新鲜度。它只证明配置层，`--check --probe` 做有界本机 initialize/tools/list，`--check --discover` 在明确授权后核对发现式 hub 后端 schema，二者仍不证明实际宿主加载；`--check --all` 会因未安装宿主而非零退出。显式恢复先 `--reconcile --dry-run --host <id>`，旧备份/归属及授权不足就停；不自动接管链接或未知记录。见[多源证据与恢复](usage.md#多源证据与显式恢复)。

## 升级、回滚和最终验收

用新 Release 的已校验脚本、固定新版本和对应资产重复上述预览/安装步骤。相同版本不同字节报 `VERSION_CONFLICT`，必须发布新版本，不覆盖旧目录。切换运行时不会刷新已复制的宿主技能；直连安装器的 `--check` 将报告与当前运行时不一致的自有技能，`--dry-run` 预告技能刷新，外部管理技能副本则只报告 `externalSkill.status:"stale"`，不改健康路由结论。Magpie `sharedSkills:true` 会把资源库中的技能链接到 `~/.agents/skills`，读这个目录的 Agent 都会拿到全部 Skill，不管勾没勾选；检查器只读跟随该共享链接并标出 `externalSkill.shared:true`、`via`、`linkExists`，不按 `agents` 勾选过滤，也不接管、不复制、不改勾选、不声称宿主已加载；刷新由原管理器完成。自有技能不一致时 `--probe` 保守跳过，不能推断端点离线。确认归属与获得写入授权后，通过原管理器或相同直连安装器刷新，再验证运行时绑定和宿主加载；直连检查不会代原管理器改写副本。无法确认归属时保持现状。指定旧版本是显式切换，通常优先用上一版本回滚：

```bash
bash ./install.sh --rollback --dry-run
bash ./install.sh --rollback
bash ./install.sh --status
```

回滚互换 current/previous，不删除版本、会话或宿主配置；没有上一版则停止。自定义安装根需在每条命令继续传 `--prefix`。升级/回滚后先确认没有在途发送，再重连实际宿主；不能自动重发 pending。旧安装记录若仍绑定已消失的 Node 物理路径，`--check` 会报告 `node path missing`；安装新版本后通过 `ccw-hosts` 或原管理器显式重连刷新，不自动改写已有宿主配置。卸载 MCP 注册是另外的 `ccw-hosts --uninstall --host 已核验的id` 操作，不是程序回滚。

最终分层验收：① status 文件/命令摘要；② ccw --help 能运行；③ 明确授权后 `ccw doctor` 核验浏览器/组织；④ 实际宿主重连后 tools/list 出现完整六工具及两个 prompt 参数中的完整指导块；⑤ 另获授权的单次真实 Claude 样本。前几层不证明后几层，更不证明长期触发率或模型遵守。

## 失败与恢复

- `SHA_MISMATCH`、归档不完整/越界/链接：不安装，重新核对可信资产；受限 USTAR 格式只接受普通文件，解压有大小上限。
- `OWNERSHIP_CONFLICT`、符号链接、源码树或未知命令：不覆盖；核对实际来源和备份后单独迁移，禁止 sudo 强装。
- `LOCKED`：停止，先确认是否有在途安装；不按 PID 猜测或自动删除锁。
- 已安装文件被改动：停止，不用新版本覆盖修改来伪造修好。
- I/O 部分失败：只恢复仍匹配本次后像的目标；不覆盖另一写入者。`RECOVERY_REQUIRED` 时保留版本和报告的恢复日志，核对前/后像后由操作者处理。文件系统不协作的替换不能完全防护，安装时应停止其他编辑器。
- 断电/进程中止可能留下锁、未完成日志或不可归属的初装目录；不自动猜测完成或删除。先只读检查并按日志核对，不回退消费开发仓库。
