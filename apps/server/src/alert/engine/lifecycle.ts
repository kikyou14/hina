import type { AgentRegistry } from "../../agents/registry";
import type { DbClient } from "../../db/client";
import type { RuntimeAgentConfigStore } from "../../settings/runtime";
import type { SiteConfigStore } from "../../settings/site-config";
import { startIntervalTask, type StopIntervalTask } from "../../util/interval-task";
import { ALERT_EVAL_INTERVAL_MS, ALERT_SEND_INTERVAL_MS } from "../constants";
import { startAlertNotificationCleanupWorker } from "./cleanup";
import { sendTick } from "./dispatcher";
import { evalTick } from "./evaluator";

export function startAlertEngine(deps: {
  db: DbClient;
  runtimeAgentConfig: RuntimeAgentConfigStore;
  siteConfig: SiteConfigStore;
  registry: AgentRegistry;
}): StopIntervalTask {
  const stopEval = startIntervalTask({
    label: "alert eval",
    intervalMs: ALERT_EVAL_INTERVAL_MS,
    tick: () => evalTick(deps),
  });

  const stopSend = startIntervalTask({
    label: "alert send",
    intervalMs: ALERT_SEND_INTERVAL_MS,
    tick: () => sendTick(deps),
  });

  const stopCleanup = startAlertNotificationCleanupWorker({ db: deps.db });

  return async () => {
    await Promise.all([stopEval(), stopSend(), stopCleanup()]);
  };
}
