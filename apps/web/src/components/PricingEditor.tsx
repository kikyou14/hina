import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRICING_CYCLE_KEYS } from "@/lib/pricing-cycles";

export type PricingFormValues = {
  currency: string;
  cycle: string;
  amount: string;
  expiresAt: string;
};

export const EMPTY_PRICING: PricingFormValues = {
  currency: "USD",
  cycle: "monthly",
  amount: "",
  expiresAt: "",
};

const CURRENCY_KEYS = ["CNY", "USD", "EUR", "GBP", "CHF"] as const;
export function pricingAmountToUnit(amount: string): number | null {
  if (!amount.trim()) return 0;
  const v = Number.parseFloat(amount);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

export function pricingUnitToAmount(unit: number): string {
  return (unit / 100).toFixed(2);
}

export function pricingDateToMs(date: string): number | null {
  if (!date.trim()) return null;
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

export function pricingMsToDate(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function PricingEditor({
  pricing,
  onChange,
  disabled,
  amountInvalid,
}: {
  pricing: PricingFormValues;
  onChange: (v: PricingFormValues) => void;
  disabled?: boolean;
  amountInvalid?: boolean;
}) {
  const { t } = useTranslation();
  const update = (partial: Partial<PricingFormValues>) => onChange({ ...pricing, ...partial });

  return (
    <div className="grid gap-2 md:grid-cols-2">
      <div className="grid gap-1">
        <Label className="text-xs">{t("agents.pricing.currency")}</Label>
        <Select
          value={pricing.currency}
          onValueChange={(v) => update({ currency: v })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCY_KEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {t(`agents.pricing.currencies.${key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">{t("agents.pricing.cycle")}</Label>
        <Select
          value={pricing.cycle}
          onValueChange={(v) => update({ cycle: v })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRICING_CYCLE_KEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {t(`agents.pricing.cycles.${key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">{t("agents.pricing.amount")}</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={pricing.amount}
          onChange={(e) => update({ amount: e.target.value })}
          disabled={disabled}
          placeholder="0.00"
          aria-invalid={amountInvalid}
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">{t("agents.pricing.expiresAt")}</Label>
        <Input
          type="date"
          value={pricing.expiresAt}
          onChange={(e) => update({ expiresAt: e.target.value })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
