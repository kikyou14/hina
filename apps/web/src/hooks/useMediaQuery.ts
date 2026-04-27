import * as React from "react";

function getMediaQuerySnapshot(query: string): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = React.useCallback(() => getMediaQuerySnapshot(query), [query]);

  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}
