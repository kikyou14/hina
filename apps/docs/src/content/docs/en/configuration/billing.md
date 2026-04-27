---
title: Billing/pricing behavior
description: How bandwidth billing, reset days, automatic renewal, and quota alerts behave
---

Hina's billing/pricing features are used to display agent traffic quotas, public pricing labels, expiry times, and related alerts. They do not throttle traffic or disconnect agents by themselves; over-quota and expiry states are mainly used for display, filtering, and alerts.

## Traffic quotas

Each agent can have a traffic quota, billing mode, and reset day.

| Field | Description |
|-------|-------------|
| Quota | Allowed traffic in the current billing period. `0` means unlimited and excludes the agent from quota alerts. |
| Billing mode | Controls how `usedBytes` is computed: `sum` is download + upload, `rx` is download only, `tx` is upload only, and `max` is the larger of download and upload. |
| Reset day | A value from `1..31`, evaluated using UTC dates. |

Billing periods use UTC day boundaries, not the site timezone. Public and admin views use the same UTC period calculation.

## Reset day

The reset day determines which day of the month starts a new billing period. For example, with reset day `15`, a new period starts on April 15 UTC.

If a month does not contain the configured day, Hina treats the effective reset point for that month as **the 1st day of the next month in UTC**. For example:

- With reset day `31`, February has no 31st day, so March 1 UTC becomes the effective reset point.
- With reset day `30`, non-leap February has no 30th day, so March 1 UTC becomes the effective reset point.

For production deployments, prefer reset days in `1..28`. Use `29..31` only when that end-of-month behavior is intentional.

## Pricing and expiry

Pricing data contains currency, amount, billing cycle, and expiry time. It is mainly used for public pricing labels and expiry-related alerts.

Supported billing cycles:

| Cycle | Auto-renew step |
|-------|-----------------|
| `monthly` | 1 month |
| `quarterly` | 3 months |
| `semiannual` | 6 months |
| `annual` | 1 year |
| `biennial` | 2 years |
| `triennial` | 3 years |
| `lifetime` | No automatic renewal |

When the expiry time is empty, the agent is not considered expiring. The `lifetime` cycle is not auto-renewed.

## Automatic renewal

The server checks expired non-`lifetime` agents once per hour and advances their expiry time into the future according to their billing cycle.

Automatic renewal only applies to agents that reported data within the last **72 hours**. Long-offline agents are not auto-renewed until they report again and re-enter the check window.

When advancing by months, if the target month does not contain the original day, the result is clamped to the last day of the target month. For example, renewing January 31 by one month lands on the last day of February.

## Quota alerts

The `quota_exceeded` alert computes usage as `usedBytes / quotaBytes` for the current billing period. Only agents with a quota greater than `0` are evaluated.

The alert condition is **strictly greater than** the threshold, not greater-than-or-equal. For example:

- Threshold `80`: fires when usage exceeds 80%.
- Threshold `100`: does not fire at exactly 100%; it fires only above 100%.

For alert lifecycle, trigger delays, and recovery notifications, see [Alerts](/en/configuration/alerts/).
