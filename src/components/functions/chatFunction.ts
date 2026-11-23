import { callAI } from '../../../../src/layers/execution/ai'

export async function processUserMessage(content: string): Promise<string> {
  const response = await callAI(content)
  return response.text || 'No response from AI'
}