import { colors } from "../theme";
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from "./PopupFrame";

type ProviderInfo = { id: string; name: string; description: string };

type ProvidersPopupProps = {
  popupWidth: number;
  popupHeight: number;
  providers: ProviderInfo[];
  cursorIndex: number;
  onSelectIndex?: (index: number) => void;
  onSelect?: (index: number) => void;
  onClose?: () => void;
};

export function ProvidersPopup({ popupWidth, popupHeight, providers, cursorIndex, onSelectIndex, onSelect, onClose }: ProvidersPopupProps) {
  return (
    <PopupOverlay onClose={onClose}>
      <box border borderStyle="rounded" style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }} width={Math.min(60, popupWidth)} height={Math.min(20, popupHeight)} padding={1} flexDirection="column" overflow="hidden">
        <PopupTitle>Select Provider</PopupTitle>
        <box flexDirection="column" marginTop={1} flexGrow={1}>
          {providers.map((p, i) => (
            <box
              key={p.id}
              width="100%"
              style={{ backgroundColor: i === cursorIndex ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
              onMouseOver={() => onSelectIndex?.(i)}
              onMouseDown={() => onSelect?.(i)}
            >
              <text fg={i === cursorIndex ? '#ffffffcc' : '#ffffff65'} bold={i === cursorIndex}>
                {i === cursorIndex ? '› ' : '  '}{p.name} - {p.description}
              </text>
            </box>
          ))}
        </box>
        <box paddingX={1} flexDirection="row" justifyContent="space-between">
          <text fg={colors.dim} wrap={false}>↑ / ↓ select · Enter to configure</text>
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
            <text fg="white" wrap={false}>Esc</text>
            <text fg="#A1A1AA" wrap={false}>close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}
