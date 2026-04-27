import type { SiteConfigStore } from "../settings/site-config";

const VALID_NONCE_PATTERN = /^[A-Za-z0-9+/=_-]+$/;
const HEAD_CLOSE_TAG = "</head>";
const TITLE_PATTERN = /<title>[\s\S]*?<\/title>/;
const FAVICON_HREF_PATTERN = /href="\/api\/public\/favicon(?:\?[^"]*)?"/;

export type RenderIndexHtmlArgs = {
  template: string;
  siteConfig: SiteConfigStore;
  isAdminPath: boolean;
  nonce?: string;
};

export function renderIndexHtml({
  template,
  siteConfig,
  isAdminPath,
  nonce,
}: RenderIndexHtmlArgs): string {
  const config = siteConfig.getCurrent();
  const version = siteConfig.faviconVersion;

  const title = config.siteName || "Hina";
  let html = template.replace(TITLE_PATTERN, `<title>${escapeHtml(title)}</title>`);

  html = html.replace(FAVICON_HREF_PATTERN, `href="/api/public/favicon?v=${version}"`);

  const injections: string[] = [];
  if (config.siteDescription) {
    injections.push(
      `    <meta name="description" content="${escapeHtml(config.siteDescription)}" />`,
    );
  }
  if (!isAdminPath && config.customHeadHtml.trim()) {
    injections.push(config.customHeadHtml);
  }

  if (injections.length > 0) {
    html = html.replace(HEAD_CLOSE_TAG, `${injections.join("\n")}\n  ${HEAD_CLOSE_TAG}`);
  }

  if (nonce && VALID_NONCE_PATTERN.test(nonce)) {
    html = html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
  }

  return html;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
