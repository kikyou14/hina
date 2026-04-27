import type { AlertChannelType } from "../types";
import { barkNotifier } from "./bark";
import { emailNotifier } from "./email";
import { serverChan3Notifier } from "./serverchan-3";
import { serverChanTurboNotifier } from "./serverchan-turbo";
import { telegramNotifier } from "./telegram";
import type { Notifier } from "./types";
import { webhookNotifier } from "./webhook";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NOTIFIER_REGISTRY: Record<AlertChannelType, Notifier<any>> = {
  webhook: webhookNotifier,
  telegram: telegramNotifier,
  email: emailNotifier,
  bark: barkNotifier,
  serverchan3: serverChan3Notifier,
  serverchanturbo: serverChanTurboNotifier,
};

/**
 * Resolve the notifier for a given channel type.
 * Returns undefined only if the type is not in the registry (should not happen
 * at compile time, but guards runtime data from the DB).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveNotifier(type: string): Notifier<any> | undefined {
  return NOTIFIER_REGISTRY[type as AlertChannelType];
}
