export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatUIProps {
  messages: Message[]
}

function alignRight(text: string): string {
  return ' '.repeat(60 - text.length) + text
}

export function ChatUI({ messages }: ChatUIProps) {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(' '.repeat(60) + 'You : ' + msg.content)
    } else {
      lines.push('AI : ' + msg.content + ' '.repeat(60 - 'AI : '.length - msg.content.length))
    }
  }

  return lines.join('\n')
}