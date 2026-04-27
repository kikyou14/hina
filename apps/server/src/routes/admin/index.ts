import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppContext } from "../../app";
import type { SessionTouchThrottler } from "../../auth/session";
import { createOriginGuard, createRequireAdmin } from "./middleware";
import { registerAdminAccountRoutes } from "./routes-account";
import { registerAdminAgentsRoutes } from "./routes-agents";
import { registerAdminAlertRoutes } from "./routes-alerts";
import { registerAdminAuditRoutes } from "./routes-audit";
import { registerAdminProbeTaskRoutes } from "./routes-probes";
import { registerAdminLoginRoutes, registerAdminSessionRoutes } from "./routes-session";
import { registerAdminSiteConfigRoutes } from "./routes-site-config";
import { registerAdminSystemRoutes } from "./routes-system";

export function createAdminRouter(touchThrottler: SessionTouchThrottler, dbPath: string) {
  const router = new Hono<AppContext>();

  router.use("*", createOriginGuard());

  registerAdminLoginRoutes(router);

  router.use("*", createRequireAdmin(touchThrottler));
  router.use(
    "*",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => c.json({ code: "payload_too_large" } as const, 413),
    }),
  );

  registerAdminSessionRoutes(router, touchThrottler);
  registerAdminAccountRoutes(router, touchThrottler);
  registerAdminAuditRoutes(router);
  registerAdminSystemRoutes(router, dbPath);
  registerAdminSiteConfigRoutes(router);
  registerAdminAgentsRoutes(router);
  registerAdminProbeTaskRoutes(router);
  registerAdminAlertRoutes(router);

  return router;
}
