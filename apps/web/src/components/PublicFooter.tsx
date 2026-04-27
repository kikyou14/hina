import DOMPurify, { type Config } from "dompurify";
import { useMemo } from "react";

import { useSiteConfig } from "@/components/SiteConfigProvider";

const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: ["a", "span", "div", "p", "br", "strong", "em", "b", "i", "img", "ul", "ol", "li"],
  ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt"],
};

export function PublicFooter() {
  const { customFooterHtml } = useSiteConfig();

  const sanitized = useMemo(
    () => (customFooterHtml ? DOMPurify.sanitize(customFooterHtml, PURIFY_CONFIG) : ""),
    [customFooterHtml],
  );

  if (sanitized) {
    return (
      <footer className="hina-custom-footer" dangerouslySetInnerHTML={{ __html: sanitized }} />
    );
  }

  return (
    <footer className="hina-public-footer text-muted-foreground border-t py-4 text-center text-xs">
      <a
        href="https://github.com/kikyou14/hina"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground transition-colors"
      >
        Hina
      </a>{" "}
      v{__APP_VERSION__}
    </footer>
  );
}
