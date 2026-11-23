import { exit } from 'bun'

export function handleCommand(input: string) {
  const parts = input.trim().split(' ')
  const command = parts[0].toLowerCase()

  switch (command) {
    case 'ask':
      // TODO: trigger AI execution layer
      console.log('Ask command received:', input)
      break
    case 'exit':
    case 'quit':
      console.log('Goodbye!')
      exit(0)
    default:
      console.log(`Unknown command: ${command}`)
  }
}