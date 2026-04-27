import * as React from "react";

import { motion } from "motion/react";

import { TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * A tab list with a sliding indicator powered by motion `layoutId`.
 *
 * Wraps Radix `TabsList` + `TabsTrigger` to preserve full keyboard
 * accessibility (roving tabindex, arrow-key navigation, aria-controls,
 * focus-visible ring). Only the active-state background is replaced by
 * the animated indicator — all other styles are inherited from shadcn.
 *
 * Must be placed inside a controlled `<Tabs value={…} onValueChange={…}>`.
 */
export function AnimatedTabsList<T extends string>({
  items,
  value,
  className,
}: {
  items: readonly { value: T; label: React.ReactNode }[];
  value: T;
  className?: string;
}) {
  const layoutId = React.useId();

  return (
    <TabsList className={className}>
      {items.map((item) => (
        <TabsTrigger
          key={item.value}
          value={item.value}
          className="data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
        >
          <span className="relative z-10">{item.label}</span>
          {value === item.value && (
            <motion.span
              layoutId={layoutId}
              className="bg-background dark:border-input dark:bg-input/30 absolute inset-0 rounded-md shadow-xs dark:border"
              transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
            />
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
