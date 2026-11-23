import { useEffect, useRef } from 'react';
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from './PopupFrame';

export const COMMANDS = [
  { key: '/new', description: 'Start new chat' },
  { key: '/sessions', description: 'View past sessions' },
  { key: '/models', description: 'Manage AI models' },
  { key: '/providers', description: 'Manage API providers' },
  { key: '/mcp', description: 'Connect MCP tool servers' },
  { key: '/updates', description: 'Check for updates' },
  { key: '/exit', description: 'Exit terminal' },
  { key: '/help', description: 'Show help' },
  { key: '/donate', description: 'Donate to support development' },
];

export type Command = (typeof COMMANDS)[number];

export function filterCommands(input: string): Command[] {
  if (!input.startsWith('/')) return [];
  const query = input.trim().toLowerCase().slice(1);
  return COMMANDS.filter(command => command.key.toLowerCase().startsWith(`/${query}`));
}

// Width of the command column, so every description starts at the same spot
const KEY_COLUMN_WIDTH = 16;
// Rows used by padding, title spacing, and footer spacing.
const CHROME_ROWS = 8;

export function CommandPopup({
  commands,
  selectedIndex,
  terminalWidth,
  terminalHeight,
  onSelectIndex,
  onRun,
  onClose,
}: {
  commands: Command[];
  selectedIndex: number;
  terminalWidth: number;
  terminalHeight: number;
  /** Called when the mouse hovers a row (update selectedIndex in the parent) */
  onSelectIndex?: (index: number) => void;
  /** Called when a row is clicked with the mouse (same action as pressing Enter) */
  onRun?: (command: Command) => void;
  onClose?: () => void;
}) {
  const scrollRef = useRef<any>(null);

  const popupWidth = Math.max(1, Math.min(56, terminalWidth - 4));
  const popupHeight = Math.max(1, Math.min(commands.length + CHROME_ROWS, terminalHeight - 2));
  const visibleRows = Math.max(1, popupHeight - CHROME_ROWS);

  // Keyboard navigation: keep the selected row inside the visible area
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top: number = box.scrollTop ?? 0;
    if (selectedIndex < top) {
      box.scrollTop = selectedIndex;
    } else if (selectedIndex >= top + visibleRows) {
      box.scrollTop = selectedIndex - visibleRows + 1;
    }
  }, [selectedIndex, visibleRows]);

  return (
    <PopupOverlay zIndex={900} onClose={onClose}>
      <box
        border
        borderStyle="rounded"
        style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }}
        width={popupWidth}
        height={popupHeight}
        padding={1}
        flexDirection="column"
        overflow="hidden"
      >
        <PopupTitle>Commands</PopupTitle>

        {/* Mouse wheel scrolling works by default inside scrollbox */}
        <scrollbox ref={scrollRef} flexGrow={1} marginTop={1}>
          {commands.map((command, index) => {
            const selected = index === selectedIndex;
            return (
              <box
                key={command.key}
                width="100%"
                flexDirection="row"
                style={{ backgroundColor: selected ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                onMouseOver={() => onSelectIndex?.(index)}
                onMouseDown={() => onRun?.(command)}
              >
                {/* Command column: fixed width, white */}
                <box width={KEY_COLUMN_WIDTH}>
                  <text fg="#ffffffcc">
                    {selected ? '› ' : '  '}
                    {command.key}
                  </text>
                </box>
                {/* Description column: always starts at the same position, gray */}
                <text fg="#ffffff65">{command.description}</text>
              </box>
            );
          })}
        </scrollbox>

        {/* Footer: keep the Esc key itself prominent and the action subdued. */}
        <box
          marginTop={1}
          paddingX={1}
          flexDirection="row"
          justifyContent="space-between"
        >
          <text fg="gray">↑ / ↓ select · Enter</text>
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
            <text fg="white">Esc</text>
            <text fg="#A1A1AA">close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}