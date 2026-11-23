import { colors } from "./theme";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}
export function InputBox({ value, onChange, onSubmit, placeholder = 'Ask dash to code something…' }: Props) {
  return (
    <box style={{ backgroundColor: colors.lowBlack }} flexDirection="column" padding={1}>
      <text>
        <span fg={colors.white}>{'>'}</span>
        <span fg={colors.white}>{value || placeholder}</span>
      </text>
    </box>
  );
}
