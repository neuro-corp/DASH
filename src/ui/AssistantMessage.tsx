interface Props {
  content: string;
}
export function AssistantMessage({ content }: Props) {
  return (
    <text>{content}</text>
  );
}
