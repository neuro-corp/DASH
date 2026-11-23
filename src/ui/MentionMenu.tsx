import { useEffect, useRef } from 'react';
import { resolveMentionPopupHeight, resolveMentionPopupWidth, type MentionSuggestion } from './mentions';
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from './popups/PopupFrame';

export function MentionMenu({
  suggestions,
  selectedIndex,
  width,
  terminalHeight,
  onSelectIndex,
  onSelect,
}: {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  width: number;
  terminalHeight: number;
  onSelectIndex: (index: number) => void;
  onSelect: (suggestion: MentionSuggestion) => void;
}) {
  const scrollRef = useRef<any>(null);
  const { height, visibleRows } = resolveMentionPopupHeight(suggestions.length, terminalHeight);

  useEffect(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    const top = Number(scrollbox.scrollTop ?? 0);
    if (selectedIndex < top) scrollbox.scrollTop = selectedIndex;
    else if (selectedIndex >= top + visibleRows) scrollbox.scrollTop = selectedIndex - visibleRows + 1;
  }, [selectedIndex, visibleRows]);

  if (suggestions.length === 0) return null;
  return (
    <PopupOverlay zIndex={900}>
      <box
        border
        borderStyle="rounded"
        style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }}
        width={width}
        height={height}
        padding={1}
        flexDirection="column"
        overflow="hidden"
      >
        <PopupTitle>Workspace files</PopupTitle>
        <scrollbox ref={scrollRef} flexGrow={1} marginTop={1}>
          {suggestions.map((suggestion, index) => (
            <box
              key={suggestion.path}
              width="100%"
              style={{ backgroundColor: index === selectedIndex ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
              onMouseOver={() => onSelectIndex(index)}
              onMouseDown={() => onSelect(suggestion)}
            >
              <text fg={index === selectedIndex ? '#ffffffcc' : '#ffffff80'}>
                {index === selectedIndex ? '› ' : '  '}▤ {suggestion.path}
              </text>
            </box>
          ))}
        </scrollbox>
        <box marginTop={1} paddingX={1} flexDirection="row" justifyContent="space-between">
          <text fg="gray">Type folder/path · ↑ / ↓ · Enter add file</text>
          <box flexDirection="row" gap={1}>
            <text fg="white">Esc</text>
            <text fg="#A1A1AA">close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}
