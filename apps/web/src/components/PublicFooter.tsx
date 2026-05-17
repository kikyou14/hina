import type { Config } from "dompurify";
import { useEffect, useState } from "react";

import { useSiteConfig } from "@/components/SiteConfigProvider";

const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: ["a", "span", "div", "p", "br", "strong", "em", "b", "i", "img", "ul", "ol", "li"],
  ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt"],
};

type Sanitizer = (html: string) => string;

let sanitizerPromise: Promise<Sanitizer> | null = null;

function loadSanitizer(): Promise<Sanitizer> {
  if (!sanitizerPromise) {
    sanitizerPromise = import("dompurify").then(
      ({ default: DOMPurify }) =>
        (html: string) =>
          DOMPurify.sanitize(html, PURIFY_CONFIG),
    );
  }
  return sanitizerPromise;
}

type FooterState = { kind: "loading" } | { kind: "ready"; source: string; html: string };

export function PublicFooter() {
  const { customFooterHtml } = useSiteConfig();
  const [state, setState] = useState<FooterState>(() =>
    customFooterHtml ? { kind: "loading" } : { kind: "ready", source: "", html: "" },
  );

  useEffect(() => {
    if (!customFooterHtml) {
      setState({ kind: "ready", source: "", html: "" });
      return;
    }
    setState({ kind: "loading" });
    let cancelled = false;
    loadSanitizer().then(
      (sanitize) => {
        if (!cancelled) {
          setState({ kind: "ready", source: customFooterHtml, html: sanitize(customFooterHtml) });
        }
      },
      () => {
        sanitizerPromise = null;
        if (!cancelled) {
          setState({ kind: "ready", source: customFooterHtml, html: "" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [customFooterHtml]);

  if (customFooterHtml) {
    if (state.kind !== "ready" || state.source !== customFooterHtml) {
      return null;
    }
    if (state.html) {
      return (
        <footer className="hina-custom-footer" dangerouslySetInnerHTML={{ __html: state.html }} />
      );
    }
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
