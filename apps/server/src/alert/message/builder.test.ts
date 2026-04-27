import { describe, expect, test } from "bun:test";

import { RULE_REGISTRY } from "../rules/registry";
import type { AlertRuleKind } from "../types";
import { buildSampleMessage } from "./builder";
import { formatPlainText } from "./format-plain";
import { formatTelegramHtml } from "./format-telegram-html";
import { formatTelegramMarkdownV2 } from "./format-telegram-md";
import { buildTemplateVars } from "./vars";

describe("buildSampleMessage", () => {
  test("builds formatter-safe sample messages for every rule kind", () => {
    for (const ruleKind of Object.keys(RULE_REGISTRY) as AlertRuleKind[]) {
      const message = buildSampleMessage(ruleKind);

      expect(() => buildTemplateVars(message, "https://example.com")).not.toThrow();
      expect(() => formatPlainText(message)).not.toThrow();
      expect(() => formatTelegramHtml(message)).not.toThrow();
      expect(() => formatTelegramMarkdownV2(message)).not.toThrow();
    }
  });
});
