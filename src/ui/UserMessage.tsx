import { colors } from "./theme";

interface Props {
  content: string;
}
export function UserMessage({ content }: Props) {
  return (
    <box width="100%" padding={1} style={{ backgroundColor: colors.surface }} border borderStyle="rounded" borderColor="#333333">
      <text fg="#E0E0E0">{content}</text>
    </box>
  );
}
