import { colors } from "../theme";
import { truncateText } from "../truncate";
import type { AgentTodo } from "../../layers/agent/tools";
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, POPUP_TITLE_BACKGROUND, PopupOverlay } from "./PopupFrame";

const LIST_ROWS = 12;

/** Warm orange used for the tick mark and the > marker */
const WARM_ORANGE = "#FF9F43";
const OUTLINE_COLOR = "#00000000";

/** Row prefix: ">" + 2 spaces + icon + space = 5 columns */
const PREFIX_WIDTH = 5;

type TodosPopupProps = {
  popupWidth: number;
  popupHeight: number;
  todos: AgentTodo[];
  scrollTop: number;
  selectedIndex: number;
  /** Called when the user clicks "Esc close" or clicks outside the popup */
  onClose?: () => void;
  /** Called on mouse wheel. delta is -1 (up) or +1 (down) */
  onScroll?: (delta: number) => void;
  /** Called when a row is clicked */
  onSelect?: (index: number) => void;
  /** Called when the pointer hovers a row */
  onHover?: (index: number) => void;
  /** Called when a todo's delete control is clicked */
  onDelete?: (index: number) => void;
};

type MouseLikeEvent = {
  stopPropagation?: () => void;
  scroll?: { direction?: "up" | "down" | "left" | "right"; delta?: number };
};

export function TodosPopup({
  popupWidth,
  popupHeight,
  todos,
  scrollTop,
  selectedIndex,
  onClose,
  onScroll,
  onSelect,
  onHover,
  onDelete,
}: TodosPopupProps) {
  const done = todos.filter(todo => todo.status === "completed").length;

  // The outline adds 2 columns/rows outside the inner box
  const innerWidth = Math.max(14, popupWidth - 2);
  // inner paddingX (2)
  const contentWidth = Math.max(10, innerWidth - 2);
  const maxTitle = Math.max(4, contentWidth - PREFIX_WIDTH);

  // Reserve a small top and bottom gap in addition to the header/footer.
  const rowsShown = Math.max(1, Math.min(LIST_ROWS, Math.max(todos.length, 1), Math.max(1, popupHeight - 9)));
  const maxScroll = Math.max(0, todos.length - rowsShown);
  const clampedTop = Math.min(Math.max(0, scrollTop), maxScroll);
  const visibleTodos = todos.slice(clampedTop, clampedTop + rowsShown);

  const hiddenAbove = clampedTop;
  const hiddenBelow = Math.max(0, todos.length - (clampedTop + visibleTodos.length));

  // Progress bar shrinks on narrow terminals
  const barWidth = Math.max(0, Math.min(10, contentWidth - 22));
  const filled = todos.length > 0 ? Math.round((done / todos.length) * barWidth) : 0;
  const barFilled = "━".repeat(filled);
  const barEmpty = "─".repeat(Math.max(0, barWidth - filled));

  const position = todos.length > 0 ? `${Math.min(selectedIndex + 1, todos.length)}/${todos.length}` : "";
  const scrollHint =
    hiddenAbove > 0 && hiddenBelow > 0 ? `↑${hiddenAbove} ↓${hiddenBelow}`
    : hiddenAbove > 0 ? `↑${hiddenAbove}`
    : hiddenBelow > 0 ? `↓${hiddenBelow}`
    : "";

  const innerHeight = Math.min(rowsShown + 8, Math.max(9, popupHeight - 2));

  const handleWheel = (event: MouseLikeEvent) => {
    const dir = event.scroll?.direction;
    if (dir === "up") onScroll?.(-1);
    else if (dir === "down") onScroll?.(1);
    event.stopPropagation?.();
  };

  return (
    <PopupOverlay onClose={onClose}>
      {/* Outline: border drawn OUTSIDE the filled box, no background of its own */}
      <box
        border
        borderStyle="rounded"
        style={{ borderColor: OUTLINE_COLOR }}
        width={popupWidth}
        height={innerHeight + 2}
        onMouseDown={(e: MouseLikeEvent) => e.stopPropagation?.()}
      >
        {/* Filled box */}
        <box
          width="100%"
          height="100%"
          paddingX={1}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
          overflow="hidden"
          style={{ backgroundColor: POPUP_BACKGROUND }}
        >
          {/* Header */}
          <box flexDirection="row" alignItems="center" marginBottom={1}>
            <box paddingX={1} style={{ backgroundColor: POPUP_TITLE_BACKGROUND }}>
              <text fg="white" bold>To-dos</text>
            </box>
            <box flexGrow={1} />
            <text wrap={false}>
              {barWidth > 0 ? <span fg={WARM_ORANGE}>{barFilled}</span> : null}
              {barWidth > 0 ? <span fg="#3A3A3A">{`${barEmpty} `}</span> : null}
              <span fg={colors.muted}>{`${done}/${todos.length}`}</span>
            </text>
          </box>

          {/* List (mouse wheel scrolls, click selects) */}
          <box flexDirection="column" onMouseScroll={handleWheel}>
            {todos.length === 0 ? (
              <text fg={colors.muted} wrap={false}>{"   No tasks yet"}</text>
            ) : (
              visibleTodos.map((todo, offset) => {
                const index = clampedTop + offset;
                const isSelected = index === selectedIndex;
                const isDone = todo.status === "completed";
                const isActive = todo.status === "in-progress";

                const icon = isDone ? "✓" : isActive ? "●" : "○";
                const iconColor = isDone ? WARM_ORANGE : isActive ? colors.accent : colors.muted;
                const titleColor = isDone ? colors.muted : isSelected || isActive ? "white" : "#5C5C5C";

                return (
                  <box
                    key={`${todo.id}-${index}`}
                    width="100%"
                    flexDirection="row"
                    style={{ backgroundColor: isSelected ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                    onMouseOver={() => onHover?.(index)}
                    onMouseDown={(e: MouseLikeEvent) => {
                      e.stopPropagation?.();
                      onSelect?.(index);
                    }}
                  >
                    <text wrap={false}>
                      <span fg={WARM_ORANGE}>{isSelected ? ">" : " "}</span>
                      <span>{"  "}</span>
                      <span fg={iconColor}>{icon}</span>
                      <span>{" "}</span>
                      <span fg={titleColor}>{truncateText(todo.title, maxTitle)}</span>
                    </text>
                  </box>
                );
              })
            )}
          </box>

          <box flexGrow={1} />

          {/* Footer, pushed to the bottom edge */}
          <box flexDirection="row" marginTop={1}>
            <text fg="gray" wrap={false}>↑↓ Move</text>
            {scrollHint ? <text fg={colors.muted} wrap={false}>{`  ${scrollHint}`}</text> : null}
            <box flexGrow={1} />
            {position && contentWidth > 30 ? <text fg={colors.muted} wrap={false}>{`${position}  `}</text> : null}
            <box flexDirection="row" gap={1} onMouseDown={(e: MouseLikeEvent) => { e.stopPropagation?.(); onClose?.(); }}>
              <text fg="white" wrap={false}>Esc</text>
              <text fg="#A1A1AA" wrap={false}>close</text>
            </box>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}