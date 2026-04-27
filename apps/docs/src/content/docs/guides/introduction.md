---
title: 介绍
description: 了解 Hina 的整体架构与核心组件
---

Hina 是一个分布式服务器监控系统，由三个组件构成：

- **`apps/server`** — 基于 Bun + Hono
- **`apps/web`** — 基于 React 19 + Vite
- **`crates/hina-agent`** — 部署在被监控主机上的 Rust agent

## 架构概览

Server 的职责：

- 托管前端静态资源
- 接收 agent 上报的 telemetry 与 probe 结果
- 将数据聚合为小时级和天级的 rollup
- 根据规则引擎评估告警并派发通知

Agent 的职责：

- 周期性采集主机指标（CPU、内存、磁盘、网络）
- 执行 probe 任务（icmp / tcp / http / traceroute）
- 通过 WebSocket 将数据上报给 server
