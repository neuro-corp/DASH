import { colors } from "./theme";

export function Header() {
  return (
    <box height={1} flexDirection="row" gap={1}>
      <text>
        <span fg={colors.white} bold>Dash</span>
      </text>
    </box>
  );
}
