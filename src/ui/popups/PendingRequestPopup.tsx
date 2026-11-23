import { useState, type Dispatch, type SetStateAction } from "react";
import { colors } from "../theme";
import { truncateText } from "../truncate";
import type { PendingRequest } from "./types";
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from "./PopupFrame";

type PendingRequestPopupProps = {
  popupWidth: number;
  popupHeight: number;
  pendingRequest: PendingRequest;
  requestChoiceIndex: number;
  setRequestChoiceIndex: Dispatch<SetStateAction<number>>;
  resolveUserRequest: (answer: string) => void;
  onClose?: () => void;
};

export function PendingRequestPopup({ popupWidth, popupHeight, pendingRequest, requestChoiceIndex, setRequestChoiceIndex, resolveUserRequest, onClose }: PendingRequestPopupProps) {
  const [answer, setAnswer] = useState('');
  const promptWidth = Math.max(12, popupWidth - 8);
  const promptLines = pendingRequest.prompt.split(/\r?\n/).reduce((total, line) => (
    total + Math.max(1, Math.ceil(line.length / promptWidth))
  ), 0);
  const actionRows = pendingRequest.kind === 'approval'
    ? 2
    : pendingRequest.options.length > 0
      ? Math.min(5, pendingRequest.options.length) + 1
      : 2;
  const desiredHeight = promptLines + actionRows + 4;
  const panelHeight = Math.max(1, Math.min(popupHeight, desiredHeight));
  const promptHeight = Math.max(1, Math.min(promptLines, panelHeight - actionRows - 3));
  const optionRows = Math.max(1, panelHeight - promptHeight - 5);
  const optionStart = Math.max(
    0,
    Math.min(pendingRequest.options.length - optionRows, requestChoiceIndex - optionRows + 1),
  );
  const visibleOptions = pendingRequest.options.slice(optionStart, optionStart + optionRows);
  const optionWidth = Math.max(1, popupWidth - 8);

  return (
    <PopupOverlay zIndex={1100} onClose={onClose}>
      <box width={popupWidth} height={panelHeight} flexDirection="row" overflow="hidden">
        <box width={1} height={panelHeight} flexDirection="column" style={{ backgroundColor: POPUP_BACKGROUND }}>
          {Array.from({ length: panelHeight }, (_, index) => (
            <text key={index} fg="#FF9F43">▎</text>
          ))}
        </box>
        <box border borderStyle="rounded" style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }} width={Math.max(1, popupWidth - 1)} height={panelHeight} padding={1} flexDirection="column" overflow="hidden">
        <PopupTitle>
          {pendingRequest.kind === 'approval' ? 'Permission request' : 'Ask a question'}
        </PopupTitle>
        <scrollbox height={promptHeight}>
          <text fg="gray">{pendingRequest.prompt}</text>
        </scrollbox>
        {pendingRequest.kind === 'approval' ? (
          <box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
            <box flexDirection="row">
              <box
                paddingX={1}
                style={{ backgroundColor: requestChoiceIndex === 0 ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                onMouseOver={() => setRequestChoiceIndex(0)}
                onMouseDown={() => { setRequestChoiceIndex(0); resolveUserRequest('yes'); }}
              >
                <text fg={requestChoiceIndex === 0 ? 'white' : 'gray'} bold={requestChoiceIndex === 0}>Allow</text>
              </box>
              <box
                paddingX={1}
                style={{ backgroundColor: requestChoiceIndex === 1 ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                onMouseOver={() => setRequestChoiceIndex(1)}
                onMouseDown={() => { setRequestChoiceIndex(1); resolveUserRequest('no'); }}
              >
                <text fg={requestChoiceIndex === 1 ? 'white' : 'gray'} bold={requestChoiceIndex === 1}>Deny</text>
              </box>
            </box>
            <box flexDirection="row" justifyContent="space-between" flexGrow={1}>
              <text fg="gray"></text>
              <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
                <text fg="white">Esc</text>
                <text fg="#A1A1AA">deny</text>
              </box>
            </box>
          </box>
        ) : pendingRequest.options.length > 0 ? (
          <box flexGrow={1} flexDirection="column" minHeight={1}>
            <box flexGrow={1} flexDirection="column">
              {visibleOptions.map((option, offset) => {
                const index = optionStart + offset;
                const selected = index === requestChoiceIndex;
                return (
                  <box
                    key={`${index}-${option}`}
                    width="100%"
                    style={{ backgroundColor: selected ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                    onMouseOver={() => setRequestChoiceIndex(index)}
                    onMouseDown={() => { setRequestChoiceIndex(index); resolveUserRequest(option); }}
                  >
                    <text fg={selected ? 'white' : 'gray'} bold={selected}>
                      {selected ? '› ' : '  '}{truncateText(option, optionWidth)}
                    </text>
                  </box>
                );
              })}
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg="gray">↑ / ↓ choose · Enter submit</text>
              <box flexDirection="row" gap={1}>
                {pendingRequest.options.length > optionRows ? (
                  <text fg="gray">{`${optionStart + 1}-${Math.min(optionStart + optionRows, pendingRequest.options.length)}/${pendingRequest.options.length}`}</text>
                ) : null}
                <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
                  <text fg="white">Esc</text>
                  <text fg="#A1A1AA">cancel</text>
                </box>
              </box>
            </box>
          </box>
        ) : (
          <box flexGrow={1} flexDirection="column" justifyContent="space-between">
            <input
              value={answer}
              onChange={setAnswer}
              width={Math.max(1, popupWidth - 4)}
              height={1}
              placeholder="Type your answer and press Enter"
              onSubmit={() => resolveUserRequest(answer)}
              backgroundColor={POPUP_BACKGROUND}
              focusedBackgroundColor={POPUP_BACKGROUND}
              focused
            />
            <box flexDirection="row" justifyContent="space-between">
              <text fg="gray">Enter submit</text>
              <box flexDirection="row" gap={2}>
                <box
                  paddingX={1}
                  style={{ backgroundColor: POPUP_ROW_HOVER }}
                  onMouseDown={event => { event.stopPropagation?.(); resolveUserRequest(answer); }}
                >
                  <text fg="#ffffffcc">Submit</text>
                </box>
                <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
                  <text fg="white">Esc</text>
                  <text fg="#A1A1AA">cancel</text>
                </box>
              </box>
            </box>
          </box>
        )}
        </box>
      </box>
    </PopupOverlay>
  );
}
