# 仓库元数据与公开边界

本文记录 README、包描述、仓库 About/topics 与公开发布边界。私有 Gitea 仍是开发真源；GitHub 公开仓库是经允许列表导出的对外快照，不承接开发、安装或发布权威。

## About / description

```text
本地 Claude 网页会话咨询桥接工具，支持 agent 宿主连续追问。(A local-browser Claude consultation bridge for agent hosts with continuous follow-ups.)
```

中文主句必须与 `package.json` 的 `description` 和 `README.md` 首个简介逐字一致；英文 README 保持同构英文定位。备用 API、MCP、CLI、附件和恢复边界放在 README 正文及 `docs/`，不塞进 About 短描述。

## Topics 建议

```text
claude-web-api, claude, agent, mcp, cli, nodejs, browser, llm, consultation, developer-tools
```

规则核对：全部小写、仅连字符/数字/字母，共 10 个，覆盖自身名、语言运行时、品类、领域能力与生态；不使用未真实支持的宿主名。私有仓库的 topics 也可能公开，公开前须复查是否泄露内部部署信息。

## 当前公开状态

- `MicTx/claude-web-api` 已存在于 GitHub，当前公开仓库包含旧的 `v0.2.18` 快照与 Release；本次只读核对未修改它。
- 当前私有 Gitea `main` 已包含后续会话状态文件权限修复；新的公开快照尚未推送，避免把“考虑公开”误当成发布授权。
- 需要同步时，必须从当前私有 `main` 重新运行允许列表导出与隐私扫描，并记录源提交、快照提交、授权范围、门禁结果和资产摘要。

## 公开同步前检查

- 私有 Gitea 已包含目标提交，Release 资产、清单和 SHA-256 核验通过。
- 用允许列表导出干净公开树；不携带 `.spec/`、`.agents/`、`.claude/`、`.codex/`、`.env*`、日志、缓存、备份、worktree、个人状态或用户数据。
- README、安装指南、社区文件和许可互链有效；无伪造 CI、版本、下载量或安全徽章。
- `SECURITY.md` 已换成公开可用的私密披露入口。
- About、topics、homepage、discussions/wiki 设置与公开范围一致；未配置 homepage 时留空。
- 提交信息、issue 模板、示例和测试均已扫描敏感信息。
- GitHub 不是开发真源；只有获得明确项目级授权后才能更新公开快照、仓库元数据或 Release。
