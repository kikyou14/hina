export function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MD_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escMarkdownV2(text: string): string {
  return text.replace(MD_V2_SPECIAL, "\\$&");
}

export type TemplateVars = {
  values: Record<string, string>;
  rawKeys: ReadonlySet<string>;
};

export function renderTemplate(
  template: string,
  vars: TemplateVars,
  escFn?: (text: string) => string,
): string {
  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key: string) => {
    const raw = vars.values[key] ?? "";
    if (vars.rawKeys.has(key)) return raw;
    return escFn ? escFn(raw) : raw;
  });
}
