import { colors } from "./theme";

interface Props {
  title: string;
  running?: boolean;
  success?: boolean;
}
export function ToolCall({ title, running, success }: Props) {
  const icon = running ? '●' : success === true ? '✓' : success === false ? '✗' : '●';
  return (
    <text fg={colors.dim}>
      <span fg={colors.white}>{icon}</span> {title}
    </text>
  );
}
