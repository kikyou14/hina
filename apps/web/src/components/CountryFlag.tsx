import countryList from "flag-icons/country.json";

import { supportsEmojiFlag } from "@/lib/emojiSupport";
import { cn } from "@/lib/utils";

type CountryEntry = { code: string };

const SUPPORTED_FLAG_CODES: ReadonlySet<string> = new Set(
  (countryList as readonly CountryEntry[]).map((c) => c.code),
);

const USE_FLAG_ICONS_FALLBACK = !supportsEmojiFlag();
if (USE_FLAG_ICONS_FALLBACK) {
  void import("flag-icons/css/flag-icons.min.css");
}

const REGIONAL_INDICATOR_A = 0x1f1e6;
const ASCII_LOWER_A = "a".charCodeAt(0);

type CountryFlagProps = {
  code: string | null | undefined;
  className?: string;
};

export function CountryFlag({ code, className }: CountryFlagProps) {
  const cc = code?.trim().toLowerCase();
  if (!cc || !SUPPORTED_FLAG_CODES.has(cc)) return null;

  const label = cc.toUpperCase();

  if (USE_FLAG_ICONS_FALLBACK) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn("fi fis leading-none", `fi-${cc}`, className)}
      />
    );
  }

  const emoji = String.fromCodePoint(
    REGIONAL_INDICATOR_A + cc.charCodeAt(0) - ASCII_LOWER_A,
    REGIONAL_INDICATOR_A + cc.charCodeAt(1) - ASCII_LOWER_A,
  );
  return (
    <span role="img" aria-label={label} title={label} className={cn("leading-none", className)}>
      {emoji}
    </span>
  );
}
