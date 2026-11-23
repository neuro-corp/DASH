import { colors } from "./theme";
import { truncateText } from "./truncate";
import type { AgentTodo } from "../layers/agent/tools";
import { color } from "bun";

const BAR_WIDTH = 10;

type TodoBarProps = {
  todos: AgentTodo[];
  terminalWidth: number;
  onOpen: () => void;
};

export function TodoBar({ todos, terminalWidth, onOpen }: TodoBarProps) {
  const done = todos.filter(todo => todo.status === 'completed').length;
  const total = todos.length;
  const current = todos.find(todo => todo.status === 'in-progress');
  const countText = `${done}/${total}`;
  const hint = ' ctrl+t';
  const chrome = 2 + 6 + countText.length + hint.length + 4;
  const maxTitle = current ? Math.max(0, terminalWidth - chrome) : 0;
  const title = current ? truncateText(current.title, maxTitle) : '';
  return (
    <box flexDirection="row" marginX={2} paddingX={1} onClick={onOpen} style={{ backgroundColor: colors.surface }}>
      <text fg="gray" wrap={false} onClick={onOpen}>{`TO-DOS ${countText} `}</text>
      <box flexGrow={1} />
      <text dim wrap={false} onClick={onOpen} fg="gray">{hint}</text>
    </box>
  );
}
