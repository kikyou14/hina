---
title: Introduction
description: Learn about Hina's architecture and core components
---

Hina is a distributed server monitoring system with three components:

- **`apps/server`** — Built with Bun + Hono
- **`apps/web`** — Built with React 19 + Vite
- **`crates/hina-agent`** — Rust agent deployed on monitored hosts

## Architecture overview

The server is responsible for:

- Hosting the built frontend assets
- Receiving telemetry and probe results from agents
- Aggregating data into hourly and daily rollups
- Evaluating alert rules and dispatching notifications

The agent is responsible for:

- Periodically collecting host metrics (CPU, memory, disk, network)
- Executing probe tasks (icmp / tcp / http / traceroute)
- Reporting data to the server over WebSocket
