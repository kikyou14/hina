---
title: Alerts
description: Configure alert channels, alert rules, and message templates
---

Manage channels and rules from the **Alerts** page in the admin panel. It is recommended to create channels first, then associate them when creating rules.

---

## Alert lifecycle

An alert goes through the following stages from trigger to resolution (for poll-based rules):

1. **Pending**: The rule condition is met but has not yet reached the trigger delay. If the condition clears during this window, no notification is sent.
2. **Firing**: The condition has held for the full trigger delay. The alert becomes active and the system sends a single **ALERT** notification to all linked channels.
3. **Recovered**: The condition is no longer met and has stayed clear for the recovery delay. The alert is closed. If recovery notifications are enabled (on by default), the system sends a single **RECOVERED** notification.

The poll evaluator runs every 10 seconds, so trigger/recovery timing is approximate and aligned to evaluation ticks.

For poll-based rules, each incident sends one firing notification, plus at most one recovery notification (depending on `notifyOnRecovery`). `route_change` (beta) is event-driven: it only sends firing notifications and applies a 1-hour per-subject cooldown. A condition can fire again only after recovery or state reset.

When a subject temporarily loses evaluable data (for example, missing agent/probe/billing data), the system silently clears that subject state without sending a recovery notification.

---

## Alert channels

Channels define where notifications are delivered. After creating a channel, you can send a **test notification** to verify the configuration.

### Webhook

Sends a JSON request to a specified URL.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | — | HTTP(S) endpoint URL |
| `method` | No | `POST` | `POST` or `PUT` |
| `timeoutMs` | No | `5000` | Request timeout (500–60,000 ms) |
| `headers` | No | — | Custom HTTP headers (key-value pairs) |
| `secret` | No | — | HMAC-SHA256 signing key |
| `messageTemplate` | No | — | Custom message template (see [Message templates](#message-templates)) |

When `secret` is set, requests include a signature header:

```
x-hina-signature: sha256=<hex_digest>
```

The signature is computed over the request body. Receivers can use it to verify the request origin.

#### Default payload

When `messageTemplate` is not set, the request body is an `AlertMessageV1` JSON structure:

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

| Field | Description |
|-------|-------------|
| `v` | Payload version, always `1` |
| `kind` | `"firing"` or `"recovered"` |
| `severity` | `"info"`, `"warning"`, or `"critical"` |
| `rule` | The triggered rule (ID, name, type) |
| `subject.key` | Alert subject identifier (e.g. `a:{agentId}` or `a:{agentId}\|t:{taskId}`) |
| `subject.agent` | Agent info (ID, name, group) |
| `subject.task` | Probe task info (only present for probe-related rules) |
| `value` | Rule-specific evaluation value; structure varies by rule type |
| `tsMs` | Event timestamp (Unix milliseconds) |

When `messageTemplate` is set, the payload gains an additional `text` field containing the rendered template output.

### Telegram

Sends messages via the Telegram Bot API.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | Yes | — | Telegram Bot Token |
| `chatId` | Yes | — | Target chat or group ID |
| `parseMode` | No | `HTML` | Message format: `HTML` or `MarkdownV2` |
| `disableNotification` | No | `false` | Send silently (no notification sound) |
| `messageThreadId` | No | — | Topic ID for forum-style groups |
| `buttons` | No | — | Inline keyboard buttons (up to 8) |
| `messageTemplate` | No | — | Custom message template |

#### Parse mode

`parseMode` controls the rich-text format of the message:

- **`HTML`** (default): Format with HTML tags such as `<b>bold</b>`, `<i>italic</i>`, `<code>code</code>`. Template variables are automatically HTML-entity-escaped. Use `{{details.html}}` to insert pre-formatted HTML details.
- **`MarkdownV2`**: Format with Telegram MarkdownV2 syntax such as `*bold*`, `_italic_`, `` `code` ``. Template variables are automatically escaped for MarkdownV2 special characters. Use `{{details.md}}` to insert pre-formatted Markdown details.

When `messageTemplate` is not set, the system automatically generates the message using the built-in formatter matching the selected `parseMode`.

#### Inline buttons

`buttons` adds clickable inline keyboard buttons below the message, displayed in a single row. The API supports up to 8 buttons; the management UI supports up to 2. Each button has:

- `text`: Label shown on the button
- `url`: Link opened when clicked

Both fields support `{{variable}}` template syntax. `url` must be a valid public HTTP(S) address (localhost and private IPs are not supported).

```json
[
  { "text": "View Dashboard", "url": "{{dashboard.url}}" },
  { "text": "Silence Rule", "url": "https://hina.example.com/admin/alerts" }
]
```

### Email

Sends email via SMTP.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `host` | Yes | — | SMTP server hostname |
| `port` | No | `587` | SMTP port |
| `secure` | No | `true` if port is 465 | Use TLS/SSL |
| `user` | No | — | SMTP username |
| `pass` | No | — | SMTP password |
| `from` | Yes | — | Sender address |
| `to` | Yes | — | Recipient address(es), comma-separated |
| `subjectPrefix` | No | — | Email subject line prefix |
| `timeoutMs` | No | `10000` | Connection timeout (500–120,000 ms) |
| `messageTemplate` | No | — | Custom message template |

### ServerChan V3

Push notifications via [ServerChan V3](https://sct.ftqq.com/).

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `sendKey` | Yes | — | SendKey (format: `sctp{uid}t...`) |
| `tags` | No | — | Tags (pipe-separated) |
| `short` | No | — | Brief summary |
| `messageTemplate` | No | — | Custom message template |

### ServerChan Turbo

Push notifications via [ServerChan Turbo](https://sct.ftqq.com/).

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `sendKey` | Yes | — | SendKey |
| `channel` | No | — | Channel name |
| `messageTemplate` | No | — | Custom message template |

### Bark

Push notifications to iOS devices via [Bark](https://github.com/Finb/Bark).

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `deviceKey` | Yes | — | Device key |
| `serverUrl` | No | `https://api.day.app` | Bark server URL |
| `sound` | No | — | Alert sound name |
| `group` | No | — | Notification group |
| `level` | No | auto-mapped | Priority: `critical`, `timeSensitive`, `active`, `passive` |
| `icon` | No | — | Icon URL |
| `messageTemplate` | No | — | Custom message template |

When `level` is not set, it is automatically mapped from alert severity: `critical` → `critical`, `warning` → `timeSensitive`, `info` → `active`.

### Test notifications

After creating or editing a channel, click the **Test** button to send a sample notification. The test message uses mock data and verifies that the channel configuration is reachable.

---

## Alert rules

Rules define the trigger conditions and notification strategy for alerts. Each rule has common fields and type-specific parameters.

### Common fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Rule name |
| `severity` | Yes | — | Severity: `info`, `warning`, or `critical` |
| `kind` | Yes | — | Rule type (see below) |
| `enabled` | No | `true` | Whether the rule is active |
| `forMs` | No | `0` | Trigger delay in milliseconds (0–86,400,000). The management UI inputs seconds and converts to milliseconds on save |
| `recoverMs` | No | `0` | Recovery delay in milliseconds (0–86,400,000). The management UI inputs seconds and converts to milliseconds on save |
| `notifyOnRecovery` | No | `true` | Send a notification on recovery |
| `channelIds` | No | `[]` | Associated channel IDs |
| `selector` | Yes | — | Scope (see below) |

### Scope

| Type | Description |
|------|-------------|
| All agents | Applies to all agents, including those added later |
| By group | All agents in the selected groups |
| Specific agents | A manually selected list of agents |

### Rule types

#### Agent offline (agent_offline)

Fires when an agent has not reported within its heartbeat grace window. No additional parameters.

#### Metric threshold (metric_threshold)

Fires when a reported metric crosses a numeric threshold.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `metric` | Yes | — | Metric key (e.g. `cpu.usage_pct`) |
| `op` | Yes | — | Operator: `>` or `<` |
| `value` | Yes | — | Threshold value |
| `missing` | No | `ignore` | Behavior when the metric is absent: `ignore` skips evaluation, `alert` treats it as condition met |

#### Probe failed (probe_failed)

Fires when the most recent result of a linked probe task is a failure.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskIds` | Yes | Probe task IDs (at least one) |

#### Probe latency (probe_latency)

Fires when a linked probe task's response latency crosses a threshold. Only evaluated on successful probes — a failed probe does not trigger a latency alert.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskIds` | Yes | Probe task IDs (at least one) |
| `op` | Yes | Operator: `>` or `<` |
| `value` | Yes | Latency threshold in milliseconds (≥ 0) |

#### Quota exceeded (quota_exceeded)

Fires when an agent's bandwidth usage percentage crosses a threshold.

The quota percentage is computed as `usedBytes / quotaBytes` for the agent's current billing period. Only agents with a quota greater than 0 are evaluated. The condition is **strictly greater than** the threshold; for example, a threshold of `100` does not fire at exactly 100%, only above 100%. For billing periods, reset days, and billing modes, see [Billing/pricing behavior](/en/configuration/billing/).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `percentage` | Yes | Percentage threshold (0–100) |

#### Agent expiring (agent_expiring)

Fires when an agent's expiry date is within the specified number of days. This rule type has no trigger or recovery delay.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `daysBeforeExpiry` | Yes | Days before expiry (1–365) |

#### Route change (beta) (route_change)

Fires when the traceroute path of a linked probe task changes. This rule type is event-driven: it has no trigger or recovery delay and does not send recovery notifications. A 1-hour cooldown applies per subject after each firing — the same subject will not trigger again during the cooldown period. This rule only reacts to traceroute path-change events.

Traceroute results on public pages are privacy-filtered. Even when "reveal hop details" is enabled, public pages do not expose hop IPs, the target IP, or the origin IP; the option only allows more non-IP hop details to be shown. When it is disabled, public pages also hide hop hostnames and ASN details. Admin views are not subject to this public anonymization rule.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskIds` | Yes | Traceroute-type probe task IDs (at least one) |

### Rules and channels

Rules and channels have a many-to-many relationship: one rule can be linked to multiple channels, and one channel can be used by multiple rules. Updating a rule's channel associations is a full replacement — passing an empty list removes all associations.

A channel's type cannot be changed after creation.

### State reset

The following actions clear all alert state for a rule (any active alerts disappear and must re-satisfy conditions to fire again):

- Changing the rule's scope
- Changing the rule's condition parameters
- Disabling and re-enabling the rule

---

## Notification delivery

### Delivery status

| Status | Description |
|--------|-------------|
| Pending | Awaiting delivery or retrying |
| Sent | Successfully delivered (terminal) |
| Dead | Failed and will not be retried (terminal) |

### Retry behavior

Failed notifications are automatically retried up to 5 times. Retry intervals use exponential backoff starting at 5 seconds, capped at 15 minutes, with random jitter added to each interval. After reaching the retry limit or encountering an unrecoverable error, the notification is marked Dead.

When a channel is disabled, Pending notifications for that channel are marked Dead by subsequent send-loop checks (usually quickly, and no later than the notification's next send attempt).

### Automatic cleanup

The system purges old notification records every 6 hours:

- Sent notifications are retained for **7 days**
- Dead notifications are retained for **30 days**

---

## Message templates

All channels support a `messageTemplate` field for customizing notification content. When not set, the system uses a built-in default format.

### Syntax

Use `{{variable}}` placeholders to reference variables:

```
{{icon}} [{{severity}}] {{rule.name}}
Agent: {{agent.name}}
Time: {{time}}
{{details}}
```

Variables are automatically escaped based on channel type (HTML entities for Telegram HTML, backslash escaping for MarkdownV2). Variables ending in `.html` or `.md` are pre-escaped and will not be double-escaped.

### Common variables

The following variables are available for all rule types:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{status}}` | Alert status | `ALERT` or `RECOVERED` |
| `{{icon}}` | Status icon | 🔴 or ✅ |
| `{{severity}}` | Severity level | `INFO`, `WARNING`, `CRITICAL` |
| `{{rule.name}}` | Rule name | `CPU High` |
| `{{rule.kind}}` | Rule type | `metric_threshold` |
| `{{agent.name}}` | Agent name | `us-west-1` |
| `{{agent.id}}` | Agent ID | `clx...` |
| `{{agent.group}}` | Agent group | `production` (empty if none) |
| `{{task.name}}` | Probe task name | `Ping Google` (empty for non-probe rules) |
| `{{time}}` | Event timestamp | `2026-04-12 15:30:00 CST` |
| `{{details}}` | Details (plain text) | `Metric: CPU Usage`<br>`Current: 95.2%`<br>`Condition: > 90%` |
| `{{details.html}}` | Details (HTML, pre-escaped) | — |
| `{{details.md}}` | Details (MarkdownV2, pre-escaped) | — |
| `{{dashboard.url}}` | Agent dashboard link (pre-escaped) | Requires Public Base URL in site settings (optionally initialized from `HINA_PUBLIC_BASE_URL`); empty when not configured |

### Rule-specific variables

#### Agent offline (agent_offline)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{offline.duration}}` | Offline duration | `2m` |

#### Metric threshold (metric_threshold)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{metric.key}}` | Metric key | `cpu.usage_pct` |
| `{{metric.name}}` | Metric display name | `CPU Usage` |
| `{{metric.value}}` | Current value | `95.2%` |
| `{{metric.threshold}}` | Threshold | `90%` |
| `{{metric.op}}` | Operator | `>` |

#### Probe failed (probe_failed)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{probe.status}}` | Probe status | `Failed` or `OK` |
| `{{probe.code}}` | HTTP status code | `502` (empty if N/A) |
| `{{probe.latency}}` | Response latency | `350.2ms` (empty if N/A) |
| `{{probe.error}}` | Error message | `connection refused` (empty if N/A) |

#### Probe latency (probe_latency)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{probe.status}}` | Probe status | `OK` |
| `{{probe.code}}` | HTTP status code | `200` |
| `{{probe.latency}}` | Response latency | `350.2ms` |
| `{{probe.error}}` | Error message | — |
| `{{probe.threshold}}` | Threshold condition | `> 200ms` |

#### Quota exceeded (quota_exceeded)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{quota.usage}}` | Usage percentage | `80%` |
| `{{quota.used}}` | Used amount | `745.06 GB` |
| `{{quota.total}}` | Total quota | `931.32 GB` |
| `{{quota.threshold}}` | Threshold | `> 75%` |
| `{{quota.mode}}` | Billing mode | `RX + TX`, `RX only`, `TX only`, `max(RX, TX)` |
| `{{quota.period}}` | Billing period | `2026-03-01 ~ 2026-04-01` |

#### Agent expiring (agent_expiring)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{expiry.date}}` | Expiry time | `2026-04-17 00:00:00 CST` |
| `{{expiry.remaining}}` | Days remaining | `5 days` |
| `{{expiry.cycle}}` | Billing cycle | `monthly` |

#### Route change (beta) (route_change)

| Variable | Description | Example |
|----------|-------------|---------|
| `{{route.prev}}` | Previous path | `AS4134 → AS174 → AS13335` |
| `{{route.current}}` | Current path | `AS4134 → AS6939 → AS13335` |

### Template examples

Custom template for a Telegram HTML channel:

```
{{icon}} <b>{{rule.name}}</b>
Status: {{status}} | Severity: {{severity}}
Agent: {{agent.name}}
Time: {{time}}

{{details.html}}
```

Plain text template for a Webhook channel:

```
[{{severity}}] {{rule.name}} - {{status}}
Agent: {{agent.name}} ({{agent.group}})
{{details}}
```
