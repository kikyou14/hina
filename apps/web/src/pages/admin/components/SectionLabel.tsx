import type * as React from "react";

export function SectionLabel(props: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={props.htmlFor}
      className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
    >
      {props.children}
    </label>
  );
}
