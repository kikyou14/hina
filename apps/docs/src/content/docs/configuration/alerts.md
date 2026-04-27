---
title: 告警
description: 配置告警通道、告警规则与消息模板
---

在管理后台的 **告警** 页面中管理通道与规则。建议先创建通道，再创建规则时关联通道。

---

## 告警生命周期

一条告警从触发到结束经历以下阶段（适用于轮询类规则）：

1. **等待（Pending）**：规则条件成立，但尚未达到触发延迟要求。如果条件在此期间恢复，不会产生任何通知。
2. **触发（Firing）**：条件持续满足达到触发延迟后，告警激活，系统向关联的通道发送一次 **ALERT** 通知。
3. **恢复（Recovered）**：条件不再成立并持续达到恢复延迟后，告警关闭。如果开启了恢复通知（默认开启），系统会发送一次 **RECOVERED** 通知。

轮询评估每 10 秒执行一次，因此触发/恢复时间是近似值，会受评估周期影响。

轮询类规则每次事件会产生一次触发通知；恢复通知最多一次（取决于 `notifyOnRecovery`）。`route_change` (beta) 属于事件类规则，只发送触发通知，并按主体应用 1 小时冷却。告警在恢复或状态被重置后，条件再次满足才会重新触发。

当主体暂时缺少可评估数据（例如节点数据、探测结果或计费数据不可用）时，系统会静默清除该主体状态，不发送恢复通知。

---

## 告警通道

通道定义了通知的发送目标。创建通道后可发送**测试通知**来验证配置是否正确。

### Webhook

向指定 URL 发送 JSON 请求。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | 是 | — | HTTP(S) 接收地址 |
| `method` | 否 | `POST` | `POST` 或 `PUT` |
| `timeoutMs` | 否 | `5000` | 请求超时（500–60,000 ms） |
| `headers` | 否 | — | 自定义 HTTP 请求头（键值对） |
| `secret` | 否 | — | HMAC-SHA256 签名密钥 |
| `messageTemplate` | 否 | — | 自定义消息模板（见[消息模板](#消息模板)） |

设置 `secret` 后，请求会携带签名头：

```
x-hina-signature: sha256=<hex_digest>
```

签名基于请求体计算。接收端可用此签名验证请求来源。

#### 默认 Payload

未设置 `messageTemplate` 时，请求体为 `AlertMessageV1` JSON 结构：

```json
{
  "v": 1,
  "kind": "firing",
  "severity": "warning",
  "rule": {
    "id": "rule_abc123",
    "name": "CPU High",
    "kind": "metric_threshold"
  },
  "subject": {
    "key": "a:agent_xyz",
    "agent": {
      "id": "agent_xyz",
      "name": "us-west-1",
      "group": "production"
    }
  },
  "value": {
    "metric": "cpu.usage_pct",
    "op": ">",
    "threshold": 90,
    "value": 95.2,
    "missing": false
  },
  "tsMs": 1712916600000
}
```

| 字段 | 说明 |
|------|------|
| `v` | Payload 版本，固定为 `1` |
| `kind` | `"firing"` 或 `"recovered"` |
| `severity` | `"info"`、`"warning"` 或 `"critical"` |
| `rule` | 触发的规则信息（ID、名称、类型） |
| `subject.key` | 告警主体标识（如 `a:{agentId}` 或 `a:{agentId}\|t:{taskId}`） |
| `subject.agent` | Agent 信息（ID、名称、分组） |
| `subject.task` | 探测任务信息（仅探测类规则存在） |
| `value` | 规则特定的评估值，结构因规则类型而异 |
| `tsMs` | 事件时间戳（Unix 毫秒） |

设置 `messageTemplate` 后，payload 会额外增加一个 `text` 字段，包含模板渲染后的文本。

### Telegram

通过 Telegram Bot API 发送消息。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `botToken` | 是 | — | Telegram Bot Token |
| `chatId` | 是 | — | 目标聊天 / 群组 ID |
| `parseMode` | 否 | `HTML` | 消息格式：`HTML` 或 `MarkdownV2` |
| `disableNotification` | 否 | `false` | 静默发送（不触发提示音） |
| `messageThreadId` | 否 | — | 论坛群组的话题 ID |
| `buttons` | 否 | — | 内联键盘按钮（最多 8 个） |
| `messageTemplate` | 否 | — | 自定义消息模板 |

#### 解析模式

`parseMode` 决定消息的富文本格式：

- **`HTML`**（默认）：使用 HTML 标签格式化，如 `<b>粗体</b>`、`<i>斜体</i>`、`<code>代码</code>`。自定义模板中的变量会自动进行 HTML 实体转义。使用 `{{details.html}}` 可插入预格式化的 HTML 详情。
- **`MarkdownV2`**：使用 Telegram MarkdownV2 语法，如 `*粗体*`、`_斜体_`、`` `代码` ``。自定义模板中的变量会自动转义 MarkdownV2 特殊字符。使用 `{{details.md}}` 可插入预格式化的 Markdown 详情。

未设置 `messageTemplate` 时，系统会根据 `parseMode` 自动选择对应的内置格式生成消息。

#### 内联按钮

`buttons` 用于在消息下方添加可点击的内联键盘按钮，显示为一行。通过 API 最多支持 8 个，管理界面最多支持 2 个。每个按钮包含：

- `text`：按钮上显示的文字
- `url`：点击后打开的链接

两个字段均支持 `{{变量}}` 模板语法。`url` 必须是合法的公网 HTTP(S) 地址（不支持 localhost 和内网 IP）。

```json
[
  { "text": "View Dashboard", "url": "{{dashboard.url}}" },
  { "text": "Silence Rule", "url": "https://hina.example.com/admin/alerts" }
]
```

### Email

通过 SMTP 发送邮件。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | 是 | — | SMTP 服务器地址 |
| `port` | 否 | `587` | SMTP 端口 |
| `secure` | 否 | 端口 465 时为 `true` | 是否使用 TLS/SSL |
| `user` | 否 | — | SMTP 用户名 |
| `pass` | 否 | — | SMTP 密码 |
| `from` | 是 | — | 发件人地址 |
| `to` | 是 | — | 收件人地址（多个用逗号分隔） |
| `subjectPrefix` | 否 | — | 邮件主题前缀 |
| `timeoutMs` | 否 | `10000` | 连接超时（500–120,000 ms） |
| `messageTemplate` | 否 | — | 自定义消息模板 |

### Server酱³

通过 [Server酱³](https://sct.ftqq.com/) 推送通知。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `sendKey` | 是 | — | SendKey（格式：`sctp{uid}t...`） |
| `tags` | 否 | — | 标签（多个用 `\|` 分隔） |
| `short` | 否 | — | 简短摘要 |
| `messageTemplate` | 否 | — | 自定义消息模板 |

### Server酱Turbo

通过 [Server酱Turbo](https://sct.ftqq.com/) 推送通知。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `sendKey` | 是 | — | SendKey |
| `channel` | 否 | — | 频道名称 |
| `messageTemplate` | 否 | — | 自定义消息模板 |

### Bark

通过 [Bark](https://github.com/Finb/Bark) 推送到 iOS 设备。

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `deviceKey` | 是 | — | 设备 Key |
| `serverUrl` | 否 | `https://api.day.app` | Bark 服务器地址 |
| `sound` | 否 | — | 提示音名称 |
| `group` | 否 | — | 通知分组 |
| `level` | 否 | 自动映射 | 优先级：`critical`、`timeSensitive`、`active`、`passive` |
| `icon` | 否 | — | 图标 URL |
| `messageTemplate` | 否 | — | 自定义消息模板 |

未指定 `level` 时，系统根据告警严重程度自动映射：`critical` → `critical`，`warning` → `timeSensitive`，`info` → `active`。

### 测试通知

创建或编辑通道后，点击 **测试** 按钮可以发送一条示例通知。测试消息使用模拟数据，用于验证通道配置是否可达。

---

## 告警规则

规则定义了告警的触发条件与通知策略。每条规则包含通用配置和类型特定的参数。

### 通用字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | 规则名称 |
| `severity` | 是 | — | 严重程度：`info`、`warning`、`critical` |
| `kind` | 是 | — | 规则类型（见下方各类型说明） |
| `enabled` | 否 | `true` | 是否启用 |
| `forMs` | 否 | `0` | 触发延迟（毫秒，0–86,400,000）。管理界面按秒输入，保存时会自动换算为毫秒 |
| `recoverMs` | 否 | `0` | 恢复延迟（毫秒，0–86,400,000）。管理界面按秒输入，保存时会自动换算为毫秒 |
| `notifyOnRecovery` | 否 | `true` | 恢复时是否发送通知 |
| `channelIds` | 否 | `[]` | 关联的通道 ID 列表 |
| `selector` | 是 | — | 适用范围（见下方说明） |

### 适用范围

| 类型 | 说明 |
|------|------|
| 全部节点 | 包括后续新增的节点 |
| 按分组 | 指定分组内的所有节点 |
| 指定节点 | 手动选择的节点列表 |

### 规则类型

#### 节点离线（agent_offline）

节点在心跳超时窗口内未上报数据时触发。无额外参数。

#### 指标阈值（metric_threshold）

节点上报的指标值超过或低于设定阈值时触发。

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `metric` | 是 | — | 指标键（如 `cpu.usage_pct`） |
| `op` | 是 | — | 运算符：`>` 或 `<` |
| `value` | 是 | — | 阈值 |
| `missing` | 否 | `ignore` | 指标缺失时的处理：`ignore` 忽略，`alert` 视为满足条件 |

#### 探测失败（probe_failed）

关联的探测任务最近一次结果为失败时触发。

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskIds` | 是 | 探测任务 ID 列表（至少一个） |

#### 探测延迟（probe_latency）

关联的探测任务响应延迟超过阈值时触发。仅在探测成功时评估——探测失败不会触发延迟告警。

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskIds` | 是 | 探测任务 ID 列表（至少一个） |
| `op` | 是 | 运算符：`>` 或 `<` |
| `value` | 是 | 延迟阈值（毫秒，≥ 0） |

#### 流量配额（quota_exceeded）

节点流量使用百分比超过阈值时触发。

配额百分比基于节点当前计费周期内的 `usedBytes / quotaBytes` 计算，只有配置了大于 0 的配额才会参与评估。触发条件是**严格大于**阈值；例如阈值为 `100` 时，正好用到 100% 不会触发，超过 100% 才会触发。计费周期、重置日和计费模式详见 [计费与定价行为](/configuration/billing/)。

| 参数 | 必填 | 说明 |
|------|------|------|
| `percentage` | 是 | 百分比阈值（0–100） |

#### 到期提醒（agent_expiring）

节点距到期日不足指定天数时触发。该类型无触发延迟和恢复延迟。

| 参数 | 必填 | 说明 |
|------|------|------|
| `daysBeforeExpiry` | 是 | 到期前天数（1–365） |

#### 路由变更 (beta)（route_change）

关联的 Traceroute 探测任务路径发生变化时触发。该类型为事件驱动，无触发延迟和恢复延迟，且不发送恢复通知。同一主体触发后有 1 小时冷却期，冷却期内不会重复触发。该规则仅对 Traceroute 路径变更事件生效。

公开页面中的 Traceroute 结果会做隐私处理。即使开启“公开每跳详情”，公开页面也不会暴露每跳 IP、目标 IP 或源 IP；该选项只允许公开更多非 IP 的 hop 信息。关闭时，公开页面还会隐藏 hop hostname 和 ASN 信息。管理员登录后的管理视图不受此公开匿名化规则影响。

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskIds` | 是 | Traceroute 类型的探测任务 ID 列表（至少一个） |

### 规则与通道

规则和通道为多对多关系：一条规则可关联多个通道，一个通道可被多条规则引用。更新规则的关联通道时为全量替换，传入空列表将移除所有关联。

通道类型在创建后不可更改。

### 状态重置

以下操作会清除规则的所有告警状态（已触发的告警将消失，需重新满足条件才会再次触发）：

- 修改规则的适用范围
- 修改规则的条件参数
- 禁用后重新启用规则

---

## 通知投递

### 投递状态

| 状态 | 说明 |
|------|------|
| Pending | 等待发送或重试中 |
| Sent | 发送成功（终态） |
| Dead | 发送失败且不再重试（终态） |

### 重试机制

发送失败的通知会自动重试，最多 5 次。重试间隔采用指数退避策略，从 5 秒起步，上限 15 分钟，每次附加随机抖动。达到重试上限或遇到不可恢复错误后，通知标记为 Dead。

禁用通道后，该通道的 Pending 通知会在后续发送轮询中被标记为 Dead（通常很快生效，最迟到该通知下一次尝试发送时）。

### 自动清理

系统每 6 小时清理历史通知记录：

- Sent 通知保留 **7 天**
- Dead 通知保留 **30 天**

---

## 消息模板

所有通道都支持 `messageTemplate` 字段，用于自定义通知消息的内容。未设置时使用系统内置的默认格式。

### 语法

使用 `{{变量名}}` 占位符引用变量：

```
{{icon}} [{{severity}}] {{rule.name}}
Agent: {{agent.name}}
Time: {{time}}
{{details}}
```

变量在渲染时会根据通道类型自动转义（Telegram HTML 通道转义 HTML 特殊字符，MarkdownV2 通道转义 Markdown 特殊字符）。以 `.html` 或 `.md` 结尾的变量为预转义变量，不会被二次转义。

### 通用变量

以下变量适用于所有规则类型：

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{status}}` | 告警状态 | `ALERT` 或 `RECOVERED` |
| `{{icon}}` | 状态图标 | 🔴 或 ✅ |
| `{{severity}}` | 严重程度 | `INFO`、`WARNING`、`CRITICAL` |
| `{{rule.name}}` | 规则名称 | `CPU High` |
| `{{rule.kind}}` | 规则类型 | `metric_threshold` |
| `{{agent.name}}` | Agent 名称 | `us-west-1` |
| `{{agent.id}}` | Agent ID | `clx...` |
| `{{agent.group}}` | Agent 分组 | `production`（无分组时为空） |
| `{{task.name}}` | 探测任务名称 | `Ping Google`（非探测规则时为空） |
| `{{time}}` | 事件时间 | `2026-04-12 15:30:00 CST` |
| `{{details}}` | 详情（纯文本） | `Metric: CPU Usage`<br>`Current: 95.2%`<br>`Condition: > 90%` |
| `{{details.html}}` | 详情（HTML 格式，预转义） | — |
| `{{details.md}}` | 详情（MarkdownV2 格式，预转义） | — |
| `{{dashboard.url}}` | Agent 面板链接（预转义） | 需在站点设置中配置 Public Base URL（默认可由 `HINA_PUBLIC_BASE_URL` 初始化），未配置时为空 |

### 规则专属变量

#### 节点离线（agent_offline）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{offline.duration}}` | 离线时长 | `2m` |

#### 指标阈值（metric_threshold）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{metric.key}}` | 指标键 | `cpu.usage_pct` |
| `{{metric.name}}` | 指标显示名 | `CPU Usage` |
| `{{metric.value}}` | 当前值 | `95.2%` |
| `{{metric.threshold}}` | 阈值 | `90%` |
| `{{metric.op}}` | 运算符 | `>` |

#### 探测失败（probe_failed）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{probe.status}}` | 探测状态 | `Failed` 或 `OK` |
| `{{probe.code}}` | HTTP 状态码 | `502`（无则为空） |
| `{{probe.latency}}` | 响应延迟 | `350.2ms`（无则为空） |
| `{{probe.error}}` | 错误信息 | `connection refused`（无则为空） |

#### 探测延迟（probe_latency）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{probe.status}}` | 探测状态 | `OK` |
| `{{probe.code}}` | HTTP 状态码 | `200` |
| `{{probe.latency}}` | 响应延迟 | `350.2ms` |
| `{{probe.error}}` | 错误信息 | — |
| `{{probe.threshold}}` | 阈值条件 | `> 200ms` |

#### 流量配额（quota_exceeded）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{quota.usage}}` | 使用百分比 | `80%` |
| `{{quota.used}}` | 已使用量 | `745.06 GB` |
| `{{quota.total}}` | 配额总量 | `931.32 GB` |
| `{{quota.threshold}}` | 阈值 | `> 75%` |
| `{{quota.mode}}` | 计费模式 | `RX + TX`、`RX only`、`TX only`、`max(RX, TX)` |
| `{{quota.period}}` | 计费周期 | `2026-03-01 ~ 2026-04-01` |

#### 到期提醒（agent_expiring）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{expiry.date}}` | 到期时间 | `2026-04-17 00:00:00 CST` |
| `{{expiry.remaining}}` | 剩余天数 | `5 days` |
| `{{expiry.cycle}}` | 付费周期 | `monthly` |

#### 路由变更 (beta)（route_change）

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{{route.prev}}` | 变更前路径 | `AS4134 → AS174 → AS13335` |
| `{{route.current}}` | 变更后路径 | `AS4134 → AS6939 → AS13335` |

### 模板示例

Telegram HTML 通道的自定义模板：

```
{{icon}} <b>{{rule.name}}</b>
Status: {{status}} | Severity: {{severity}}
Agent: {{agent.name}}
Time: {{time}}

{{details.html}}
```

Webhook 通道的纯文本模板：

```
[{{severity}}] {{rule.name}} - {{status}}
Agent: {{agent.name}} ({{agent.group}})
{{details}}
```
