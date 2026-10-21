import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { AdminListRow, type AdminListRowProps } from "./AdminList";

export function SortableList({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Keep the dragged row on the vertical axis and inside the list.
  const restrictToContainer = React.useCallback<Modifier>(({ draggingNodeRect, transform }) => {
    const container = containerRef.current?.getBoundingClientRect();
    if (!draggingNodeRect || !container) {
      return { ...transform, x: 0 };
    }
    const minY = container.top - draggingNodeRect.top;
    const maxY = container.bottom - draggingNodeRect.bottom;
    return { ...transform, x: 0, y: Math.min(Math.max(transform.y, minY), maxY) };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToContainer]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={containerRef}>{children}</div>
      </SortableContext>
    </DndContext>
  );
}

export function SortableRow({
  id,
  draggable,
  ...props
}: Omit<AdminListRowProps, "handle"> & { id: string; draggable: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !draggable });

  return (
    <AdminListRow
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      }}
      handle={
        <div className="w-6 shrink-0">
          {draggable ? (
            <DragHandle
              activatorRef={setActivatorNodeRef}
              attributes={attributes}
              listeners={listeners}
            />
          ) : null}
        </div>
      }
      {...props}
    />
  );
}

// The drag attributes live on the handle, not on the row: dnd-kit's KeyboardSensor
// rejects keydowns whose target is not the registered activator, and `role="button"`
// on the row would swallow the links and buttons nested inside it.
function DragHandle({
  activatorRef,
  attributes,
  listeners,
}: {
  activatorRef: (node: HTMLElement | null) => void;
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
}) {
  const { t } = useTranslation();
  const label = t("common.dragToReorder");
  return (
    <button
      ref={activatorRef}
      {...attributes}
      {...listeners}
      type="button"
      className="text-muted-foreground hover:text-foreground flex cursor-grab items-center justify-center rounded p-1 active:cursor-grabbing"
      aria-label={label}
      title={label}
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
  );
}
