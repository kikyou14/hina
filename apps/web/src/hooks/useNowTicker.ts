import * as React from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";

let nowMs = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    nowMs = Date.now();
    timer = setInterval(() => {
      nowMs = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return nowMs;
}

export function useNowTicker(): number {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type NowPrimitive = string | number | boolean | bigint | symbol | null | undefined;

// Object selectors must provide a comparator so each tick does not create a new snapshot.
export function useNowValue<T extends NowPrimitive>(select: (nowMs: number) => T): T;
export function useNowValue<T>(select: (nowMs: number) => T, isEqual: (a: T, b: T) => boolean): T;
export function useNowValue<T>(select: (nowMs: number) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, select, isEqual);
}
