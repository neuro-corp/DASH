import { colors } from "./theme";

const commands = ['/clear', '/model', '/help', '/exit'];

interface Props {
  query: string;
  onSelect: (cmd: string) => void;
}
export function SlashMenu({ query, onSelect }: Props) {
  const filtered = commands.filter(c => c.includes(query.replace('/', '')));
  return (
    <box border borderStyle="rounded" borderColor={colors.border} padding={1} flexDirection="column" style={{ backgroundColor: colors.lowBlack }}>
      {filtered.map(c => (
        <text key={c} fg={colors.white}>{c}</text>
      ))}
    </box>
  );
}
