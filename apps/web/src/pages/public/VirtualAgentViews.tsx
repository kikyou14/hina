import * as React from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";

import type { PublicAgentSummary } from "@/api/public";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { AgentCard, AgentListHeader, AgentListRow, AgentListRowCompact } from "./AgentViews";

const MD_QUERY = "(min-width: 768px)";
const LG_QUERY = "(min-width: 1024px)";
const XL_QUERY = "(min-width: 1280px)";

const LIST_OVERSCAN = 8;
const GRID_OVERSCAN = 4;

function useWindowVirtualizerAnchor<T extends HTMLElement>(
  deps: React.DependencyList,
): readonly [React.RefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null);
  const [scrollMargin, setScrollMargin] = React.useState(0);

  const measure = React.useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const next = node.getBoundingClientRect().top + window.scrollY;
    setScrollMargin((current) => (current === next ? current : next));
  }, []);

  React.useLayoutEffect(() => {
    measure();

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    const node = ref.current;
    if (node) observer?.observe(node);
    if (document.body) observer?.observe(document.body);

    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, ...deps]);

  return [ref, scrollMargin];
}

function getVirtualRowStyle(
  start: number,
  scrollMargin: number,
): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start - scrollMargin}px)`,
  };
}

function useAgentGridColumnCount(): number {
  const isMd = useMediaQuery(MD_QUERY);
  const isLg = useMediaQuery(LG_QUERY);
  const isXl = useMediaQuery(XL_QUERY);

  if (isXl) return 4;
  if (isLg) return 3;
  if (isMd) return 2;
  return 1;
}

export const PublicAgentListVirtualView = React.memo(function PublicAgentListVirtualView({
  agents,
}: {
  agents: readonly PublicAgentSummary[];
}) {
  const isDesktop = useMediaQuery(LG_QUERY);
  const [listRef, scrollMargin] = useWindowVirtualizerAnchor<HTMLDivElement>([
    agents.length,
    isDesktop,
  ]);

  const estimateSize = React.useCallback(() => (isDesktop ? 64 : 122), [isDesktop]);
  const rowVirtualizer = useWindowVirtualizer({
    count: agents.length,
    estimateSize,
    overscan: LIST_OVERSCAN,
    scrollMargin,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualBody = (
    <div
      style={{
        height: rowVirtualizer.getTotalSize(),
        position: "relative",
      }}
    >
      {virtualItems.map((virtualItem) => {
        const agent = agents[virtualItem.index];
        if (!agent) return null;

        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={rowVirtualizer.measureElement}
            style={getVirtualRowStyle(virtualItem.start, rowVirtualizer.options.scrollMargin)}
          >
            {isDesktop ? <AgentListRow a={agent} /> : <AgentListRowCompact a={agent} />}
          </div>
        );
      })}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="rounded-lg border">
        <AgentListHeader />
        <div ref={listRef}>{virtualBody}</div>
      </div>
    );
  }

  return (
    <div ref={listRef} className="rounded-lg border">
      {virtualBody}
    </div>
  );
});

export const PublicAgentCardsVirtualGrid = React.memo(function PublicAgentCardsVirtualGrid({
  agents,
}: {
  agents: readonly PublicAgentSummary[];
}) {
  const columnCount = useAgentGridColumnCount();
  const rowCount = Math.ceil(agents.length / columnCount);
  const [gridRef, scrollMargin] = useWindowVirtualizerAnchor<HTMLDivElement>([
    agents.length,
    columnCount,
  ]);

  const estimateSize = React.useCallback(() => 240, []);
  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize,
    overscan: GRID_OVERSCAN,
    scrollMargin,
  });

  return (
    <div ref={gridRef}>
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rowStart = virtualRow.index * columnCount;
          const rowAgents = agents.slice(rowStart, rowStart + columnCount);
          const isLastRow = virtualRow.index === rowCount - 1;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className={isLastRow ? undefined : "pb-4"}
              style={getVirtualRowStyle(virtualRow.start, rowVirtualizer.options.scrollMargin)}
            >
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                }}
              >
                {rowAgents.map((agent) => (
                  <AgentCard key={agent.id} a={agent} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
