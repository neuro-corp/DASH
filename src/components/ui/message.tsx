import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const BG = "#18181B";
const BORDER = "#00000000";
const HIDE_AFTER_MS = 4000;

/**
 * CopyMessage - toast shown at the top-right when text is copied.
 * - Black background with a low-gray outline
 * - Auto-hides after 4 seconds
 * - High zIndex so it sits above everything
 */
export function CopyMessage({
  text,
  onComplete,
}: {
  text: string | null;
  onComplete?: () => void;
}) {
  // Keep the latest callback in a ref so a new function identity
  // on every parent render doesn't restart the timer.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!text) return;
    const timeout = setTimeout(() => onCompleteRef.current?.(), HIDE_AFTER_MS);
    return () => clearTimeout(timeout);
  }, [text]);

  if (!text) return null;

  // border (2) + paddingX (2)
  const width = text.length + 4;

  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={9999}
      width={width}
      height={3}
      border
      borderStyle="rounded"
      paddingX={1}
      style={{ borderColor: BORDER, backgroundColor: BG }}
    >
      <text fg="#FFFFFF" wrap={false}>
        {text}
      </text>
    </box>
  );
}

/* -------------------------------------------------------------------------- */
/*  Provider + hook                                                           */
/* -------------------------------------------------------------------------- */

type CopyMessageContextValue = {
  /** Show the toast. Defaults to "Copied". */
  showCopyMessage: (text?: string) => void;
};

const CopyMessageContext = createContext<CopyMessageContextValue>({
  showCopyMessage: () => {},
});

export function useCopyMessage(): CopyMessageContextValue {
  return useContext(CopyMessageContext);
}

/**
 * CopyMessageProvider - manages the toast state.
 * Call `useCopyMessage().showCopyMessage()` after copying to the clipboard.
 */
export function CopyMessageProvider({ children }: { children: ReactNode }) {
  // `id` changes on every call so copying twice in a row restarts the timer,
  // even when the text is identical.
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);

  const showCopyMessage = useCallback((text: string = "Selected Text Copied") => {
    setToast(prev => ({ id: (prev?.id ?? 0) + 1, text }));
  }, []);

  const hide = useCallback(() => setToast(null), []);

  const value = useMemo(() => ({ showCopyMessage }), [showCopyMessage]);

  return (
    <CopyMessageContext.Provider value={value}>
      {children}
      <CopyMessage key={toast?.id} text={toast?.text ?? null} onComplete={hide} />
    </CopyMessageContext.Provider>
  );
}