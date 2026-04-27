// Evaluator: how often the poll loop runs
export const ALERT_EVAL_INTERVAL_MS = 10_000;
// Dispatcher: how often the send loop checks for pending notifications
export const ALERT_SEND_INTERVAL_MS = 1_000;
// Dispatcher: max notifications pulled per send tick
export const ALERT_NOTIFICATION_SEND_BATCH = 50;

export const ALERT_DISPATCH_CHANNEL_CONCURRENCY = 8;

export const ALERT_DISPATCH_TICK_DEADLINE_MS = 15_000;

export const ALERT_DISPATCH_SEND_HARD_TIMEOUT_MS = 150_000;

export const ALERT_DISPATCH_CLAIM_LEASE_MS = 300_000;

// Dispatcher: retry policy
export const ALERT_NOTIFICATION_MAX_ATTEMPTS = 5;
export const ALERT_NOTIFICATION_BACKOFF_BASE_MS = 5_000;
export const ALERT_NOTIFICATION_BACKOFF_MAX_MS = 15 * 60 * 1_000; // 15 min

// Value/error payload size caps (bytes before truncation)
export const MAX_VALUE_JSON_LEN = 32_768;
export const MAX_ERROR_LEN = 2_048;

// Event-mode rules: default debounce window for route_change
export const ROUTE_CHANGE_COOLDOWN_MS = 60 * 60 * 1_000; // 1 hour

// Cleanup worker
export const NOTIFICATION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours
export const NOTIFICATION_SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
export const NOTIFICATION_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
