import { POPUP_BACKGROUND, PopupOverlay, PopupTitle } from './PopupFrame';

export type UpdatePopupStatus = 'checking' | 'available' | 'installing' | 'restart' | 'error';

type UpdatesPopupProps = {
	popupWidth: number;
	popupHeight: number;
	status: UpdatePopupStatus;
	installedVersion?: string;
	latestVersion?: string;
	error?: string;
	onUpdate?: () => void;
	onRestart?: () => void;
	onClose?: () => void;
};

export function UpdatesPopup({
	popupWidth,
	popupHeight,
	status,
	installedVersion,
	latestVersion,
	error,
	onUpdate,
	onRestart,
	onClose,
}: UpdatesPopupProps) {
	const isBusy = status === 'checking' || status === 'installing';
	const title = {
		checking: 'Checking for updates…',
		available: 'Update available',
		installing: 'Downloading and installing update…',
		restart: 'Update installed',
		error: 'Update failed',
	}[status];

	return (
		<PopupOverlay zIndex={1200} onClose={onClose}>
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
				<PopupTitle>Updates</PopupTitle>
				<box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
					<text fg="white">{title}</text>
					{status === 'available' && (
						<text fg="gray">{installedVersion} → {latestVersion}</text>
					)}
					{status === 'restart' && (
						<text fg="gray">Restart Dash to use version {latestVersion}.</text>
					)}
					{status === 'error' && (
						<text fg="#E06C75">{error || 'Please try again later.'}</text>
					)}
				</box>
				<box paddingX={1} flexDirection="row" justifyContent="space-between">
					<box onMouseDown={event => {
						event.stopPropagation?.();
						if (status === 'available') onUpdate?.();
						else if (status === 'restart') onRestart?.();
					}}>
						<text fg={status === 'available' || status === 'restart' ? '#ffffffcc' : 'gray'}>
							{status === 'available' ? 'Enter Update' : status === 'restart' ? 'Enter Restart' : isBusy ? 'Please wait…' : ' '}
						</text>
					</box>
					<box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose?.(); }}>
						<text fg="white">Esc</text>
						<text fg="#A1A1AA">Close</text>
					</box>
				</box>
			</box>
		</PopupOverlay>
	);
}
