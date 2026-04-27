CREATE TABLE `agent` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`group_id` text,
	`is_public` integer DEFAULT false NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`note` text,
	`geo_country_code` text,
	`geo_country` text,
	`geo_source` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_token_hash_unique` ON `agent` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_agent_group_id` ON `agent` (`group_id`);--> statement-breakpoint
CREATE TABLE `agent_billing` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`quota_bytes` integer DEFAULT 0 NOT NULL,
	`mode` text NOT NULL,
	`reset_day` integer DEFAULT 1 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_group_name_unique` ON `agent_group` (`name`);--> statement-breakpoint
CREATE TABLE `agent_pricing` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`cycle` text NOT NULL,
	`amount_unit` integer NOT NULL,
	`expires_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_pricing_expires` ON `agent_pricing` (`expires_at_ms`);--> statement-breakpoint
CREATE TABLE `agent_status` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`online` integer DEFAULT false NOT NULL,
	`last_seen_at_ms` integer,
	`last_ip_v4` text,
	`last_ip_v6` text,
	`last_host` text,
	`last_os` text,
	`last_arch` text,
	`last_agent_version` text,
	`last_capabilities_json` text,
	`last_hello_at_ms` integer,
	`last_seq` integer,
	`last_metrics_pack` blob,
	`last_inventory_pack` blob,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alert_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alert_channel_enabled` ON `alert_channel` (`enabled`);--> statement-breakpoint
CREATE TABLE `alert_notification` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`subject_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`event_ts_ms` integer NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at_ms` integer NOT NULL,
	`last_error` text,
	`sent_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `alert_channel`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_alert_notification_pending` ON `alert_notification` (`status`,`next_attempt_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_alert_notification_created` ON `alert_notification` (`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_alert_notification_cooldown` ON `alert_notification` (`rule_id`,`subject_key`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `alert_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`severity` text NOT NULL,
	`kind` text NOT NULL,
	`selector_json` text NOT NULL,
	`params_json` text NOT NULL,
	`for_ms` integer NOT NULL,
	`recover_ms` integer NOT NULL,
	`notify_on_recovery` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alert_rule_enabled` ON `alert_rule` (`enabled`);--> statement-breakpoint
CREATE TABLE `alert_rule_channel` (
	`rule_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `channel_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `alert_channel`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_alert_rule_channel_channel_id` ON `alert_rule_channel` (`channel_id`);--> statement-breakpoint
CREATE TABLE `alert_state` (
	`rule_id` text NOT NULL,
	`subject_key` text NOT NULL,
	`subject_json` text NOT NULL,
	`active` integer NOT NULL,
	`pending_since_ms` integer,
	`recover_since_ms` integer,
	`active_since_ms` integer,
	`last_eval_at_ms` integer NOT NULL,
	`last_value_json` text,
	`last_fired_at_ms` integer,
	`last_recovered_at_ms` integer,
	PRIMARY KEY(`rule_id`, `subject_key`),
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rule`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_alert_state_active` ON `alert_state` (`active`);--> statement-breakpoint
CREATE INDEX `idx_alert_state_last_eval` ON `alert_state` (`last_eval_at_ms`);--> statement-breakpoint
CREATE TABLE `app_kv` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempt` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts_ms` integer NOT NULL,
	`success` integer NOT NULL,
	`user_id` text,
	`username_attempted` text,
	`ip` text,
	`user_agent` text,
	`reason` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_login_attempt_ts` ON `login_attempt` (`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_login_attempt_ip_ts` ON `login_attempt` (`ip`,`ts_ms`);--> statement-breakpoint
CREATE TABLE `metric_rollup` (
	`agent_id` text NOT NULL,
	`interval_sec` integer NOT NULL,
	`bucket_start_ms` integer NOT NULL,
	`samples` integer NOT NULL,
	`cpu_pct` real,
	`cpu_samples` integer DEFAULT 0 NOT NULL,
	`mem_used_pct` real,
	`mem_used_samples` integer DEFAULT 0 NOT NULL,
	`disk_used_pct` real,
	`disk_used_samples` integer DEFAULT 0 NOT NULL,
	`proc_count` real,
	`proc_count_samples` integer DEFAULT 0 NOT NULL,
	`conn_tcp` real,
	`conn_tcp_samples` integer DEFAULT 0 NOT NULL,
	`conn_udp` real,
	`conn_udp_samples` integer DEFAULT 0 NOT NULL,
	`rx_bytes_sum` integer NOT NULL,
	`tx_bytes_sum` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `interval_sec`, `bucket_start_ms`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_metric_rollup_interval_bucket` ON `metric_rollup` (`interval_sec`,`bucket_start_ms`);--> statement-breakpoint
CREATE TABLE `probe_result` (
	`id` integer PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`recv_ts_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`lat_ms` integer,
	`code` integer,
	`err` text,
	`extra_json` text,
	`loss_pct` real,
	`jitter_ms` real,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_result_agent_task_ts` ON `probe_result` (`agent_id`,`task_id`,`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_probe_result_task_ts` ON `probe_result` (`task_id`,`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_probe_result_recv_ts` ON `probe_result` (`recv_ts_ms`);--> statement-breakpoint
CREATE TABLE `probe_result_daily` (
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`bucket_start_ms` integer NOT NULL,
	`samples` integer NOT NULL,
	`ok_samples` integer NOT NULL,
	`lat_samples` integer NOT NULL,
	`lat_sum_ms` integer NOT NULL,
	`lat_min_ms` integer,
	`lat_max_ms` integer,
	`loss_samples` integer NOT NULL,
	`loss_sum_pct` real NOT NULL,
	`loss_max_pct` real,
	`jit_samples` integer NOT NULL,
	`jit_sum_ms` real NOT NULL,
	`jit_max_ms` real,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `task_id`, `bucket_start_ms`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_result_daily_task_bucket` ON `probe_result_daily` (`task_id`,`bucket_start_ms`);--> statement-breakpoint
CREATE INDEX `idx_probe_result_daily_bucket` ON `probe_result_daily` (`bucket_start_ms`);--> statement-breakpoint
CREATE TABLE `probe_result_hourly` (
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`bucket_start_ms` integer NOT NULL,
	`samples` integer NOT NULL,
	`ok_samples` integer NOT NULL,
	`lat_samples` integer NOT NULL,
	`lat_sum_ms` integer NOT NULL,
	`lat_min_ms` integer,
	`lat_max_ms` integer,
	`loss_samples` integer NOT NULL,
	`loss_sum_pct` real NOT NULL,
	`loss_max_pct` real,
	`jit_samples` integer NOT NULL,
	`jit_sum_ms` real NOT NULL,
	`jit_max_ms` real,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `task_id`, `bucket_start_ms`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_result_hourly_task_bucket` ON `probe_result_hourly` (`task_id`,`bucket_start_ms`);--> statement-breakpoint
CREATE INDEX `idx_probe_result_hourly_bucket` ON `probe_result_hourly` (`bucket_start_ms`);--> statement-breakpoint
CREATE TABLE `probe_result_latest` (
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`recv_ts_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`lat_ms` integer,
	`code` integer,
	`err` text,
	`extra_json` text,
	`loss_pct` real,
	`jitter_ms` real,
	`route_observation_signature` text,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `task_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_result_latest_task_id` ON `probe_result_latest` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_probe_result_latest_agent_id` ON `probe_result_latest` (`agent_id`);--> statement-breakpoint
CREATE TABLE `probe_task` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target_json` text NOT NULL,
	`interval_sec` integer NOT NULL,
	`timeout_ms` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`all_agents` integer DEFAULT false NOT NULL,
	`trace_reveal_hop_details` integer DEFAULT false NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_probe_task_kind` ON `probe_task` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_probe_task_enabled` ON `probe_task` (`enabled`);--> statement-breakpoint
CREATE TABLE `probe_task_agent` (
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`task_id`, `agent_id`),
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_task_agent_agent_id` ON `probe_task_agent` (`agent_id`);--> statement-breakpoint
CREATE TABLE `probe_task_group` (
	`task_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`task_id`, `group_id`),
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_probe_task_group_group_id` ON `probe_task_group` (`group_id`);--> statement-breakpoint
CREATE TABLE `route_change_state` (
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`stable_signature` text,
	`stable_observed_at_ms` integer,
	`candidate_signature` text,
	`candidate_first_seen_at_ms` integer,
	`candidate_last_seen_at_ms` integer,
	`candidate_seen_count` integer DEFAULT 0 NOT NULL,
	`candidate_strong_seen_count` integer DEFAULT 0 NOT NULL,
	`last_observation_ts_ms` integer,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `task_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `probe_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_route_change_state_task_id` ON `route_change_state` (`task_id`);--> statement-breakpoint
CREATE TABLE `traffic_counter` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`last_ts_ms` integer NOT NULL,
	`last_rx_bytes_total` integer NOT NULL,
	`last_tx_bytes_total` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `traffic_day` (
	`agent_id` text NOT NULL,
	`day_yyyymmdd` integer NOT NULL,
	`rx_bytes` integer NOT NULL,
	`tx_bytes` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `day_yyyymmdd`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_traffic_day_day` ON `traffic_day` (`day_yyyymmdd`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_login_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `user_session` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_session_user_id` ON `user_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_session_expires` ON `user_session` (`expires_at_ms`);
