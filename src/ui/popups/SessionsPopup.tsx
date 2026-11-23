import { colors } from "../theme";
import { truncateText } from "../truncate";
import type { ChatSession } from "../../layers/sessions/storage";
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from "./PopupFrame";

type SessionsPopupProps = {
  popupWidth: number;
  popupHeight: number;
  sessions: ChatSession[];
  sessionIndex: number;
  currentSessionId: string;
  onSelectIndex?: (index: number) => void;
  onSelect?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  onClose?: () => void;
};

export function SessionsPopup({ popupWidth, popupHeight, sessions, sessionIndex, currentSessionId, onSelectIndex, onSelect, onDelete, onClose }: SessionsPopupProps) {
  return (
    <PopupOverlay onClose={onClose}>
      <box border borderStyle="rounded" style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }} padding={1} flexDirection="column" width={popupWidth} height={popupHeight} overflow="hidden">
        <PopupTitle>Sessions</PopupTitle>
        <scrollbox flexGrow={1}>
          {(() => {
            let prevDate = '';
            return sessions.map((session, idx) => {
              const selected = idx === sessionIndex;
              const current = session.id === currentSessionId;
              const titleColor = selected ? colors.white : current ? '#FF9F43' : '#808080';
              const date = new Date(session.updatedAt);
              const dateLabel = Number.isNaN(date.getTime()) ? '' : `${String(date.getDate()).padStart(2,'0')}.${String(date.getMonth()+1).padStart(2,'0')}.${date.getFullYear()}`;
              const showDate = dateLabel !== prevDate;
              if (showDate) prevDate = dateLabel;
              return (
                <box
                  key={session.id}
                  width="100%"
                  flexDirection="column"
                >
                  {showDate && <text fg={colors.dim}>{dateLabel}</text>}
                  <box
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    style={{ backgroundColor: selected ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                    onMouseOver={() => onSelectIndex?.(idx)}
                    onMouseDown={() => onSelect?.(session.id)}
                  >
                    <text>
                      <span fg={selected ? '#ffffffcc' : current ? '#FF9F43' : '#ffffff65'}>
                        {selected ? '› ' : '  '}
                      </span>
                      <span fg={selected ? '#ffffffcc' : titleColor}>{truncateText(session.title || 'New chat', 40)}</span>
                    </text>
                    {selected && onDelete ? (
                      <box onMouseDown={event => { event.stopPropagation?.(); onDelete(session.id); }}>
                        <text fg="#F87171">×</text>
                      </box>
                    ) : null}
                  </box>
                </box>
              );
            });
          })()}
        </scrollbox>
        <box height={1} />
        <box paddingX={1} flexDirection="row" justifyContent="space-between">
          <text fg={colors.dim} wrap={false}>↑ / ↓ select · Enter · Ctrl+D delete</text>
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
            <text fg="white" wrap={false}>Esc</text>
            <text fg="#A1A1AA" wrap={false}>close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}
