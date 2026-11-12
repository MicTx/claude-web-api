# 仓库元数据建议

以下文案用于未来公开快照的 About、topics 与仓库设置。本文只记录建议；本轮不调用远端 API，不修改 Gitea 或 GitHub 元数据。

## About / description

```text
让 agent 宿主通过本地浏览器中的 Claude 网页会话获取第二意见，支持连续追问。(Local-browser consultation bridge for agent hosts.)
```

该中文主句与 `package.json` 的 `description` 及双语 README 首段语义一致。公开前再核对三处是否仍同步。

## Topics 建议

```text
claude-web-api, claude, agent, mcp, cli, nodejs, browser, llm, consultation, developer-tools
```

规则核对：全部小写、仅连字符/数字/字母，共 10 个，覆盖自身名、语言运行时、品类、领域能力与生态；不使用未真实支持的宿主名。私有仓库的 topics 也可能公开，公开前须复查是否泄露内部部署信息。

## 公开前检查

- 私有 Gitea 已包含目标提交，Release 资产、清单和 SHA-256 核验通过。
- 用允许列表导出干净公开树；不携带 `.spec/`、`.agents/`、`.claude/`、`.codex/`、`.env*`、日志、缓存、备份、worktree、个人状态或用户数据。
- README、安装指南、社区文件和许可互链有效；无伪造 CI、版本、下载量或安全徽章。
- `SECURITY.md` 已换成公开可用的私密披露入口。
- About、topics、homepage、discussions/wiki 设置与公开范围一致；未配置 homepage 时留空。
- 提交信息、issue 模板、示例和测试均已扫描敏感信息。
- GitHub 仍不是开发真源；只有获得明确项目级授权后才能创建公开快照。
