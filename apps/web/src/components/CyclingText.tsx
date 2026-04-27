import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";

type CyclingTextProps = {
  items: readonly React.ReactNode[];
  index: number;
  className?: string;
};

const FADE_VARIANTS = {
  initial: { opacity: 0, y: -3 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 3 },
} as const;

const FADE_TRANSITION = { duration: 0.12, ease: "easeOut" } as const;

export function CyclingText({ items, index, className }: CyclingTextProps) {
  const shouldReduceMotion = useReducedMotion();

  if (items.length === 0) return null;
  if (items.length === 1) {
    return <span className={className}>{items[0]}</span>;
  }

  const safeIndex = ((index % items.length) + items.length) % items.length;

  if (shouldReduceMotion) {
    return <span className={className}>{items[safeIndex]}</span>;
  }

  return (
    <span className={`relative inline-block ${className ?? ""}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={safeIndex}
          variants={FADE_VARIANTS}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={FADE_TRANSITION}
          className="inline-block"
        >
          {items[safeIndex]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
