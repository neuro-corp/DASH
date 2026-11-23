import { colors } from "../theme";
import { truncateText } from "../truncate";
import { MODELS_VISIBLE_ROWS, providerQualifiedModelId, type ModelGroup } from "./model-search";
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from "./PopupFrame";

type ModelsPopupProps = {
  popupWidth: number;
  popupHeight: number;
  groups: ModelGroup[];
  cursorIndex: number;
  scrollTop: number;
  currentModel: string;
  currentProvider: string;
  search: string;
  onSearchChange: (value: string) => void;
  displayNames?: Record<string, string>;
  loading?: boolean;
  error?: string | null;
  onSubmit?: () => void;
  onSelectIndex?: (index: number) => void;
  onSelect?: (index: number) => void;
  onScroll?: (delta: number) => void;
  onClose?: () => void;
};

const ACCENT_COLOR = '#FF8904';      // provider names, search cursor, selected (current) model
const SEARCH_BG_COLOR = '#333333';   // search bar background
const SEARCH_PLACEHOLDER_COLOR = '#52575B';
const CURSOR_COLOR = '#333333';
const PROVIDER_COLOR = '#4A4A4A';

export function ModelsPopup({
  popupWidth,
  popupHeight,
  groups,
  cursorIndex,
  scrollTop,
  currentModel,
  currentProvider,
  search,
  onSearchChange,
  displayNames = {},
  loading = false,
  error = null,
  onSubmit,
  onSelectIndex,
  onSelect,
  onScroll,
  onClose,
}: ModelsPopupProps) {
  const rows: Array<{ provider: string; model: string | null }> = groups.flatMap(group => [
    { provider: group.provider, model: null },
    ...group.models.map(model => ({ provider: group.provider, model })),
  ]);
  const visibleRows = rows.slice(scrollTop, scrollTop + MODELS_VISIBLE_ROWS);

  const contentWidth = Math.max(12, popupWidth - 4);
  const modelCount = groups.reduce((total, group) => total + group.models.length, 0);
  const footerHint = search.trim()
    ? `${modelCount} ${modelCount === 1 ? 'match' : 'matches'} · ↑/↓ select · Enter`
    : '↑/↓ select · Enter';
  const errorLine = error ? truncateText(error.split('\n')[0] ?? '', Math.max(10, popupWidth - 14)) : '';

  return (
    <PopupOverlay onClose={onClose}>
      <box
        border
        borderStyle="rounded"
        style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }}
        width={popupWidth}
        height={Math.min(22, popupHeight)}
        flexDirection="column"
        overflow="hidden"
      >
        <box paddingX={1} paddingTop={1}>
          <PopupTitle>Models</PopupTitle>
        </box>
        <box paddingX={1} paddingTop={1} paddingBottom={1} flexDirection="row" alignItems="center">
          <input
            value={search}
            onInput={onSearchChange}
            onSubmit={onSubmit}
            focused
            placeholder="Search models…"
            width={Math.max(8, popupWidth - 8)}
            backgroundColor={SEARCH_BG_COLOR}
            focusedBackgroundColor={SEARCH_BG_COLOR}
            textColor={colors.white}
            focusedTextColor={colors.white}
            placeholderColor={SEARCH_PLACEHOLDER_COLOR}
            cursorColor={CURSOR_COLOR}
          />
        </box>

        <box
          height={MODELS_VISIBLE_ROWS + 3}
          paddingX={1}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={(event: { scroll?: { direction?: string }; stopPropagation?: () => void }) => {
            if (event.scroll?.direction === 'up') onScroll?.(-1);
            if (event.scroll?.direction === 'down') onScroll?.(1);
            event.stopPropagation?.();
          }}
        >
          {loading && rows.length === 0 ? (
            <text fg={colors.dim}>Loading models…</text>
          ) : rows.length > 0 ? visibleRows.map((row, localIndex) => {
            const index = scrollTop + localIndex;

            if (row.model === null) {
              return (
                <box
                  key={`provider-${index}-${row.provider}`}
                  height={1}
                  marginTop={index === scrollTop ? 0 : 1}
                  flexDirection="row"
                >
                  <text fg={PROVIDER_COLOR} bold wrap={false}>{row.provider}</text>
                </box>
              );
            }

            const model = row.model;
            const isCursor = index === cursorIndex;
            const isCurrent = providerQualifiedModelId(row.provider, model)
              === providerQualifiedModelId(currentProvider, currentModel);
            const isDash = row.provider === 'DASH';
            const displayName = isDash ? (displayNames[model] ?? model) : model;
            const nameWidth = Math.max(6, contentWidth - 2 - (isDash ? 5 : 0));
            const name = truncateText(displayName, nameWidth);

            // Cursor row = white, selected (current) model = orange, everything else = gray.
            // "Free" always uses the same color as its model name.
            const textColor = isCursor ? colors.white : isCurrent ? ACCENT_COLOR : colors.dim;

            return (
              <box
                key={`model-${index}-${model}`}
                height={1}
                flexDirection="row"
                justifyContent="space-between"
                width="100%"
                style={{ backgroundColor: isCursor ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                onMouseOver={() => onSelectIndex?.(index)}
                onMouseDown={() => onSelect?.(index)}
              >
                <text fg={textColor} bold={isCursor} wrap={false}>
                  {isCursor ? '› ' : '  '}{name}
                </text>
                {isDash && (
                  <text fg={textColor} wrap={false}>Free</text>
                )}
              </box>
            );
          }) : (
            <text fg={colors.dim}>{search.trim() ? 'No models match your search' : 'No models available'}</text>
          )}
        </box>

        <box paddingX={1} marginTop={1} flexDirection="row" justifyContent="space-between">
          {errorLine
            ? <text fg="#E06C75" wrap={false}>{errorLine}</text>
            : <text fg={colors.dim} wrap={false}>{footerHint}</text>}
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
            <text fg="white" wrap={false}>Esc</text>
            <text fg="#A1A1AA" wrap={false}>close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}