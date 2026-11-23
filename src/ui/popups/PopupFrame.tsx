import type { ReactNode } from 'react';

export const POPUP_BACKGROUND = '#1d1d1e';
export const POPUP_BACKDROP = '#0A0A0A80';
export const POPUP_TITLE_BACKGROUND = '#1a181700';
export const POPUP_ROW_HOVER = '#3b4455';

export function PopupOverlay({ children, onClose, zIndex = 1000 }: { children: ReactNode; onClose?: () => void; zIndex?: number }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={zIndex}
      alignItems="center"
      justifyContent="center"
      style={{ backgroundColor: POPUP_BACKDROP }}
      onMouseDown={() => onClose?.()}
    >
      <box onMouseDown={event => event.stopPropagation?.()}>
        {children}
      </box>
    </box>
  );
}

export function PopupTitle({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="row" marginTop={-1}>
      <box paddingX={1} style={{ backgroundColor: POPUP_TITLE_BACKGROUND }}>
        <text fg="white" bold>{children}</text>
      </box>
    </box>
  );
}
