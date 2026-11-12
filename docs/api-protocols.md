# 备用 API 三协议参考

协议字段核对日期：2026-11-05；Messages SSE 本地实现与离线入口回归：2026-11-08。协议由 `apiProtocol`（`CCW_API_PROTOCOL`）显式选择，不自动探测、不自动切换。

新别名的 `model` 字段优先使用请求显式值，其次 `CCW_API_MODEL`；两者都未设置时从宿主模型目录选择最新 Claude Opus。模型在别名创建时固定为提供方原始标识，后续修改配置或追问都不会迁移旧别名。

## 请求字段

| 配置值 | 端点 | 强度字段 | 含思考的输出上限 |
|---|---|---|---|
| `messages`（默认） | `/v1/messages` | `thinking: {"type":"adaptive"}` + `output_config.effort` | `max_tokens` |
| `chat` | `/v1/chat/completions` | `reasoning_effort` | `max_completion_tokens` |
| `responses` | `/v1/responses` | `reasoning.effort` | `max_output_tokens` |

Messages 的强度值是 `low` / `medium` / `high` / `xhigh` / `max`。当前 OpenAI 两协议的官方枚举另有 `none` / `minimal`，也包含 `max`；**并非每个模型都支持所有档位**。本客户端原样发送，不把 `max` 静默降成 `xhigh`。网关或模型拒绝时直接报错，不重试。

`off` 是本项目的省略字段开关，三个协议均不发推理配置，让模型使用自身默认值；它不等于 `none`，也不保证关闭思考。`none` / `minimal` 只允许在 Chat/Responses 配置，Messages 在发送前拒绝。Opus 5.5 原生默认是 medium，不能关闭 adaptive thinking。

三种协议都把 `apiMaxTokens` 作为严格输出硬上限；推理消耗也计入该预算，不自动增加 32768 留量。`apiMaxTokens` 默认 2048，范围为 1–65536，配置本身不被改写。所有协议的一次发送总时限仍由 `CCW_TIMEOUT_MS` 限制，最多 600s；Messages 的 ping/delta 不延长总时限，超时可能已计费，仍保留 pending。

示例（不含密钥）：

```json
{
  "apiProtocol": "responses",
  "apiReasoning": "max",
  "apiMaxTokens": 2048,
  "apiContextTokens": 16000
}
```

以上配置发 `reasoning: {"effort":"max"}` 和 `max_output_tokens: 2048`，并把估算输入历史限制在 16000 tokens。切换协议只对新别名生效；已有别名遇到不匹配会报 `API_PROFILE_CHANGED`，不自动迁移。

## 身份、缓存与状态

- 新别名固定端点、模型、protocol；显式 `--model` 优先于 `apiModel`，后者未配置时从宿主目录选最新 Claude Opus。旧别名沿用已存模型，不迁移动态默认；显式选模别名不受后续 `apiModel` 变化影响，非显式别名的配置模型改变仍报 `API_PROFILE_CHANGED`。旧历史没有 protocol 时按 Messages 读取。
- 三种协议都维持 `metadata.user_id` 与 `x-session-affinity` 的同一 UUID，本地保留完整文本历史，每轮发送预算内最新的完整 user/assistant 轮次后缀。
- 输入预算 `apiContextTokens` 默认 16000，使用保守估算 `ceil(UTF-8 bytes / 2) + 每消息 32 + 固定 256`；服务端 usage 是实际 token 事实。每次请求还必须让实际 JSON 不超过 256 KiB，超出时优先丢弃旧轮次；当前轮单独超 token 报 `API_INPUT_BUDGET`，单独超 JSON 报 `API_CONTEXT_LIMIT`。窗口只省略旧轮次，不拆分消息、不自动摘要、不修改持久化历史，结果报告估算 token、`requestBytes`、`retainedTurns` / `omittedTurns`。
- Chat/Responses 发 `store: false`（JSON 为 `store:false`），不用 `previous_response_id`，不建立远端存储链；Responses 不启用后台任务。
- 只有 Messages 发送 `cache_control` 断点。Chat/Responses 的缓存由服务端自动决定，返回 `cache.control: "automatic"`；`apiCache: off` 不能承诺禁用服务端自动缓存。
- Messages 断点固定在载荷第 0 条消息和上一轮完整 assistant 边界（通常是倒数第二条消息），不给本轮新增 user 尾部打点：尾帧之后仍可能变化，提前打点会降低稳定前缀命中率。滚动窗口未淘汰旧轮时保持稳定前缀；淘汰旧轮后允许一次缓存重建。
- 请求 JSON 不超过 256 KiB，最终文本最多 128 KiB。Messages SSE 总线字节上限 8 MiB、单事件上限 1 MiB、最多 100000 个事件/32 个内容块；Chat/Responses JSON 响应仍最多 1 MiB。拒绝重定向、工具调用及非终态 Responses；不重试、不自动切协议。
- 发送整流策略：POST 默认 `maxAttempts: 1`；超时、断流、取消、重定向、认证和契约错误不重试。只有显式确认端点幂等后才允许一次有界重试。读操作与付费发送不同，GET/HEAD 可在同一 deadline 内一次重试，但当前 API 发送路径不产生这类自动重试。

## Messages SSE

- Messages 发送 `stream: true` 与 `Accept: text/event-stream`，必须收到 SSE；不把 JSON 响应静默当成非流式成功，也不回退重发。Chat/Responses 保持 `stream: false` 与 JSON，网页的 `rest-sse` 是独立路径。
- 顺序接收 `message_start` → 内容块 start/delta/stop → `message_delta` → `message_stop`。支持 UTF-8 跨 chunk、CR/LF/CRLF、多行 data、注释、ping 和有界未知事件。仅积累可见 text；thinking/signature/redacted_thinking 不返回、不落历史。
- usage 在 `message_start` 初始化，在 `message_delta` 按**累计值覆盖**，不是逐帧相加；后帧省略或 null 的字段保留前值，明确的 0 保留为 0。网关在 message_delta 才给全 input/cache 计数也可读取。reasoningTokens 仍只读可选计数，不估算思考文本。
- 只有完整分帧的 `message_stop`、有效 stop reason 和非空有界文本才完成一轮；不用 EOF 补造未分帧的终止事件，也不等服务器再关闭连接。`max_tokens`/`model_context_window_exceeded` 在已终止时保存 `complete:false`；此前断流为 `API_STREAM_INCOMPLETE`，远端 error 为 `API_REMOTE_ERROR`，畸形/超限/取消/总超时同样保留 pending。partial delta 不进入历史或错误正文，后续发送仍被 `PENDING_TURN` 阻止。
- CLI/MCP 继续在终止后返回一个完整 JSON 结果，**不是向调用者逐 token 输出**。内部持续读 SSE 可减少“生成期间没有字节”导致的边缘空闲超时，但依赖服务端实际发送并冲刷 ping/delta；不能解决请求开始即被拒的 429，也不能保证 524 消失。
- 用户报告同中继的手工 `stream:true` 探针返回规范序列与计数；本轮交付证据是独立 SSE 夹具及实际 Bridge/CLI/MCP 离线入口，未用旧 pending 重试收费请求，不把探针报告或离线通过冒充修复后生产 live 验收。

## 诊断与响应

`ccw doctor` 的 `api.protocol` 和 `api.request`（`path` / `fields`）使用和请求体同一个装饰函数。真实 ApiBridge ask/followUp、CLI 与 MCP 子进程都有 HTTP 接收端断言，避免只测 `apiRequest` 的假通过。

`usage.reasoningTokens` 的读取规则：

| 协议 | 来源 | 缺失时 |
|---|---|---|
| Messages | 网关可选的 `usage.output_tokens_details.thinking_tokens` | `null` |
| Chat | `usage.completion_tokens_details.reasoning_tokens` | `null` |
| Responses | `usage.output_tokens_details.reasoning_tokens` | `null` |

不读取思考正文、不从思考块长度估算 token。明确的 0 与缺失的 `null` 不同。`inputTokens` / `outputTokens` 同样只用服务端计数，缓存详情也只在存在时报告，不估计金额。

`stopReason` 保留原生终止原因：Messages 的 `end_turn` / `max_tokens` 等、Chat 的 `stop` / `length` / `content_filter`、Responses 的 `completed` 或 `incomplete_details.reason`。截断或过滤时 `complete:false`，有界可见文本照常保存；未终止、失败、未知原因、纯工具调用或无可见文本不能冒充可重放的文字答复，按不确定发送保留 pending。

## 实测边界

2026-11-05，经授权向同一个兼容网关分别发三个协议的 low/max 各一次，使用同一道附加取模条件的排列计数题，本地穷举真值为 23。六次都返回 200 和正确答案，说明这些请求形状被本网关接受。

- Messages：low/max 都报告 `thinking_tokens:0`。
- Chat 与 Responses：返回总输入/输出用量，但缺失思考 token 详情。
- 以上样本**不能证明**网关剥离了 effort，也不能证明哪一种协议的 max 真正生效。即使有一组用量差异，也只能作为单样本迹象，不是网关内部行为的证明。因此不自动更换用户配置。
- 先前 main 的 `ApiBridge.#requestConfig` 漏传 apiReasoning，导致 doctor 报 max，真实请求却无强度字段；本轮通过真实入口回归修复。过去直接调用构造函数的探针不能替代该回归。

## 一手来源

- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)：`output_config.effort`、档位、模型支持和默认值。
- [官方 Messages 流式用量回归](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/tests/api-resources/MessageStream.test.ts)及[流式类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)：message_delta 为累计用量，省略的 input/cache 字段保留 message_start 值（本轮经 Context7 定向读取）。
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)：`reasoning.effort`、模型相关支持、输出预算与 reasoning token 用量。
- [Chat create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：`reasoning_effort` 和 `max_completion_tokens`。
- [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)：`reasoning`、`max_output_tokens`、`store`、status 与 incomplete_details。
- [官方 openai-node shared types](https://github.com/openai/openai-node/blob/master/src/resources/shared.ts)：当前 reasoning effort 枚举，包括 `max`。

一手来源已直接读取或经 Context7 读取，不再以之前网络失败时的搜索摘要作为最终证据。官方枚举和网关实测是两层证据，不推定兼容网关具有所有原生 API 的行为。
