import * as React from "react";
import { useTranslation } from "react-i18next";

import type { SiteConfig } from "@/api/adminSiteConfig";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getUserErrorMessage } from "@/lib/userErrors";

const FAVICON_MAX_SIZE = 256 * 1024;
const CUSTOM_HTML_MAX_LENGTH = 16 * 1024;

export function SiteConfigForm(props: {
  current: SiteConfig;
  defaults: SiteConfig;
  pending: boolean;
  onSubmit: (patch: Partial<SiteConfig>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [siteName, setSiteName] = React.useState(props.current.siteName);
  const [siteDescription, setSiteDescription] = React.useState(props.current.siteDescription);
  const [favicon, setFavicon] = React.useState(props.current.favicon);
  const [customHeadHtml, setCustomHeadHtml] = React.useState(props.current.customHeadHtml);
  const [customFooterHtml, setCustomFooterHtml] = React.useState(props.current.customFooterHtml);
  const [timezone, setTimezone] = React.useState(props.current.timezone);
  const [error, setError] = React.useState<string | null>(null);
  const faviconInputRef = React.useRef<HTMLInputElement>(null);

  const timezoneOptions = React.useMemo(() => Intl.supportedValuesOf("timeZone"), []);

  React.useEffect(() => {
    setSiteName(props.current.siteName);
    setSiteDescription(props.current.siteDescription);
    setFavicon(props.current.favicon);
    setCustomHeadHtml(props.current.customHeadHtml);
    setCustomFooterHtml(props.current.customFooterHtml);
    setTimezone(props.current.timezone);
  }, [
    props.current.siteName,
    props.current.siteDescription,
    props.current.favicon,
    props.current.customHeadHtml,
    props.current.customFooterHtml,
    props.current.timezone,
  ]);

  function handleFaviconSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > FAVICON_MAX_SIZE) {
      setError(t("settings.site.faviconTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setFavicon(reader.result as string);
    reader.onerror = () => setError(t("settings.site.faviconReadError"));
    reader.readAsDataURL(file);
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        if (customHeadHtml.length > CUSTOM_HTML_MAX_LENGTH) {
          setError(t("settings.site.customHtmlTooLarge"));
          return;
        }
        if (customFooterHtml.length > CUSTOM_HTML_MAX_LENGTH) {
          setError(t("settings.site.customHtmlTooLarge"));
          return;
        }
        try {
          const patch: Partial<SiteConfig> = {};
          if (siteName !== props.current.siteName) patch.siteName = siteName;
          if (siteDescription !== props.current.siteDescription)
            patch.siteDescription = siteDescription;
          if (favicon !== props.current.favicon) patch.favicon = favicon;
          if (customHeadHtml !== props.current.customHeadHtml)
            patch.customHeadHtml = customHeadHtml;
          if (customFooterHtml !== props.current.customFooterHtml)
            patch.customFooterHtml = customFooterHtml;
          if (timezone !== props.current.timezone) patch.timezone = timezone;
          if (Object.keys(patch).length === 0) return;
          await props.onSubmit(patch);
        } catch (err) {
          setError(
            getUserErrorMessage(err, t, {
              action: "update",
              fallback: t("settings.site.updateFailed"),
            }),
          );
        }
      }}
    >
      <div className="grid gap-2">
        <Label>{t("settings.site.favicon")}</Label>
        <div className="flex items-center gap-3">
          <img
            src={favicon || "/icon/favicon-32x32.png"}
            alt="favicon"
            className="size-8 rounded border object-contain p-0.5"
          />
          <input
            ref={faviconInputRef}
            type="file"
            accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon"
            className="hidden"
            onChange={handleFaviconSelect}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.pending}
            onClick={() => faviconInputRef.current?.click()}
          >
            {t("settings.site.faviconUpload")}
          </Button>
          {favicon ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.pending}
              onClick={() => setFavicon("")}
            >
              {t("settings.site.faviconReset")}
            </Button>
          ) : null}
        </div>
        <div className="text-muted-foreground text-xs">{t("settings.site.faviconHint")}</div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label>{t("settings.site.siteName")}</Label>
          <Input
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder={props.defaults.siteName}
            disabled={props.pending}
          />
          <div className="text-muted-foreground text-xs">{t("settings.site.siteNameHint")}</div>
        </div>
        <div className="grid gap-2">
          <Label>{t("settings.site.siteDescription")}</Label>
          <Input
            value={siteDescription}
            onChange={(e) => setSiteDescription(e.target.value)}
            disabled={props.pending}
          />
          <div className="text-muted-foreground text-xs">
            {t("settings.site.siteDescriptionHint")}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <Label>{t("settings.site.timezone")}</Label>
        <Select value={timezone} onValueChange={setTimezone} disabled={props.pending}>
          <SelectTrigger>
            <SelectValue placeholder={props.defaults.timezone} />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {timezoneOptions.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-muted-foreground text-xs">{t("settings.site.timezoneHint")}</div>
      </div>

      <div className="grid gap-2">
        <Label>{t("settings.site.customHeadHtml")}</Label>
        <Textarea
          value={customHeadHtml}
          onChange={(e) => setCustomHeadHtml(e.target.value)}
          rows={6}
          className="font-mono text-sm"
          disabled={props.pending}
        />
        <div className="text-muted-foreground text-xs">{t("settings.site.customHeadHtmlHint")}</div>
      </div>

      <div className="grid gap-2">
        <Label>{t("settings.site.customFooterHtml")}</Label>
        <Textarea
          value={customFooterHtml}
          onChange={(e) => setCustomFooterHtml(e.target.value)}
          rows={4}
          className="font-mono text-sm"
          disabled={props.pending}
        />
        <div className="text-muted-foreground text-xs">
          {t("settings.site.customFooterHtmlHint")}
        </div>
      </div>

      {error ? (
        <div className="text-destructive text-sm" role="alert">
          {error}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={props.pending}>
          {props.pending ? t("common.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
