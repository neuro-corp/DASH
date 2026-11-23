import { useEffect, useRef } from 'react';
import type { McpServerConfig } from '../../layers/agent/mcp';
import { POPUP_BACKGROUND, POPUP_ROW_HOVER, PopupOverlay, PopupTitle } from './PopupFrame';

export type McpServerRow = {
  config: McpServerConfig;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
};

export function McpPopup({
  popupWidth,
  popupHeight,
  servers,
  cursorIndex,
  guideOpen,
  busyServer,
  onSelectIndex,
  onToggleServer,
  onDisableServer,
  onRemoveServer,
  onGuide,
  onBack,
  onClose,
}: {
  popupWidth: number;
  popupHeight: number;
  servers: McpServerRow[];
  cursorIndex: number;
  guideOpen: boolean;
  busyServer?: string;
  onSelectIndex: (index: number) => void;
  onToggleServer: (server: McpServerConfig) => void;
  onDisableServer: (server: McpServerConfig) => void;
  onRemoveServer: (server: McpServerConfig) => void;
  onGuide: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<any>(null);
  const width = Math.max(1, Math.min(60, popupWidth - 4));
  const height = Math.max(1, Math.min(guideOpen ? 18 : servers.length + 10, popupHeight - 2));
  const visibleRows = Math.max(1, height - 8);

  useEffect(() => {
    if (guideOpen || !scrollRef.current) return;
    const scrollbox = scrollRef.current;
    const top = Number(scrollbox.scrollTop ?? 0);
    if (cursorIndex < top) scrollbox.scrollTop = cursorIndex;
    else if (cursorIndex >= top + visibleRows) scrollbox.scrollTop = cursorIndex - visibleRows + 1;
  }, [cursorIndex, guideOpen, visibleRows]);

  return (
    <PopupOverlay zIndex={920} onClose={onClose}>
      <box
        border
        borderStyle="rounded"
        style={{ borderColor: '#00000000', backgroundColor: POPUP_BACKGROUND }}
        width={width}
        height={height}
        padding={1}
        flexDirection="column"
        overflow="hidden"
        onMouseDown={event => event.stopPropagation?.()}
      >
        <PopupTitle>{guideOpen ? 'MCP · Guide to add' : 'MCP Servers'}</PopupTitle>
        {guideOpen ? (
          <box flexGrow={1} flexDirection="column" marginTop={1}>
            <text fg="#ffffffcc">Connect an MCP server to give Dash additional tools.</text>
            <text fg="#ffffff80"> </text>
            <text fg="#ffffffcc">HTTP server</text>
            <text fg="#ffffff80">/mcp add-http &lt;name&gt; &lt;https://server.example/mcp&gt;</text>
            <text fg="#ffffff80">Optional auth: --header Authorization=&quot;Bearer TOKEN&quot;</text>
            <text fg="#ffffff80"> </text>
            <text fg="#ffffffcc">Local stdio server</text>
            <text fg="#ffffff80">/mcp add &lt;name&gt; -- &lt;command&gt; [args...]</text>
            <text fg="#ffffff80">Add environment values with --env KEY=value before --.</text>
            <text fg="#ffffff80"> </text>
            <text fg="#ffffff80">Then choose Connect here, or type /mcp connect &lt;name&gt;.</text>
            <text fg="#ffffff80">Every external MCP tool call asks for approval.</text>
          </box>
        ) : (
          <>
            <scrollbox ref={scrollRef} flexGrow={1} marginTop={1}>
              {servers.length === 0 ? (
                <box paddingX={1}>
                  <text fg="#ffffff80">No MCP servers configured yet.</text>
                </box>
              ) : servers.map((server, index) => {
                const selected = index === cursorIndex;
                const busy = busyServer?.toLowerCase() === server.config.name.toLowerCase();
                const status = busy
                  ? 'Connecting…'
                  : server.connected
                    ? `Connected · ${server.toolCount} tools`
                    : server.enabled ? 'Disconnected · auto-connect on' : 'Disabled · auto-connect off';
                return (
                  <box
                    key={server.config.name}
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    style={{ backgroundColor: selected ? POPUP_ROW_HOVER : POPUP_BACKGROUND }}
                    onMouseOver={() => onSelectIndex(index)}
                    onMouseDown={() => onToggleServer(server.config)}
                  >
                    <box flexDirection="column" flexGrow={1}>
                      <text fg={selected ? '#ffffffcc' : '#ffffffa0'} bold={selected}>
                        {selected ? '› ' : '  '}{server.config.name}
                      </text>
                      <text fg="#ffffff65">  {status}</text>
                    </box>
                    <box flexDirection="row" gap={1}>
                      <box onMouseDown={event => { event.stopPropagation?.(); onToggleServer(server.config); }}>
                        <text fg={server.connected ? '#A7D7A7' : '#ffffff80'}>
                          {busy ? '…' : server.connected ? 'Disconnect' : 'Connect'}
                        </text>
                      </box>
                      {!server.connected && server.enabled && !busy && (
                        <box onMouseDown={event => { event.stopPropagation?.(); onDisableServer(server.config); }}>
                          <text fg="#ffffff65">Disable</text>
                        </box>
                      )}
                      <box onMouseDown={event => { event.stopPropagation?.(); onRemoveServer(server.config); }}>
                        <text fg="#ffffff65">×</text>
                      </box>
                    </box>
                  </box>
                );
              })}
            </scrollbox>
            <box
              flexDirection="row"
              paddingX={1}
              style={{ backgroundColor: POPUP_BACKGROUND }}
              onMouseDown={event => { event.stopPropagation?.(); onGuide(); }}
            >
              <text fg="#ffffffcc" bold>＋ Guide to add</text>
            </box>
          </>
        )}
        <box marginTop={1} paddingX={1} flexDirection="row" justifyContent="space-between">
          <text fg="gray" wrap={false}>
            {guideOpen ? 'Esc / Enter · Back' : '↑ / ↓ · Enter connect · Ctrl+D remove'}
          </text>
          {guideOpen && (
            <box onMouseDown={event => { event.stopPropagation?.(); onBack(); }}>
              <text fg="#ffffffcc">← Back</text>
            </box>
          )}
          <box flexDirection="row" gap={1} onMouseDown={event => { event.stopPropagation?.(); onClose(); }}>
            <text fg="white" wrap={false}>Esc</text>
            <text fg="#A1A1AA" wrap={false}>close</text>
          </box>
        </box>
      </box>
    </PopupOverlay>
  );
}
