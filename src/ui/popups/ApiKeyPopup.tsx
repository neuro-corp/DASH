import { colors } from "../theme";
import { POPUP_BACKGROUND, PopupOverlay, PopupTitle } from "./PopupFrame";

type ApiKeyPopupProps = {
  popupWidth: number;
  popupHeight: number;
  apiKeyInput: string;
  setApiKeyInput: (value: string) => void;
  saveApiKey: () => void;
  providerName?: string;
  onClose?: () => void;
};

export function ApiKeyPopup({ popupWidth, popupHeight, apiKeyInput, setApiKeyInput, saveApiKey, providerName = 'API KEY', onClose }: ApiKeyPopupProps) {
  return (
    <PopupOverlay onClose={onClose}>
      <box border borderStyle="rounded" style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }} width={popupWidth} height={Math.min(12, popupHeight)} padding={1} flexDirection="column" overflow="hidden">
        <PopupTitle>{providerName.toUpperCase()} API KEY</PopupTitle>
        <box marginTop={1}>
          <input value={apiKeyInput} onChange={setApiKeyInput} onSubmit={saveApiKey} focused placeholder="..." />
        </box>
        <box flexDirection="row" marginTop={1}>
          <text dim>Get API from </text>
          <text fg="gray">{providerName}</text>
        </box>
        <box paddingX={1} flexDirection="row" justifyContent="space-between" marginTop={1}>
          <box onMouseDown={event => { event.stopPropagation?.(); saveApiKey(); }}>
            <text fg={colors.dim} wrap={false}>Enter to save</text>
          </box>
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
            <text fg="white" wrap={false}>Esc</text>
            <text fg="#A1A1AA" wrap={false}>close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}
