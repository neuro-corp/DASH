export interface AIResponse {
  text: string
  success: boolean
}

export async function callAI(prompt: string): Promise<AIResponse> {
  // TODO: Implement actual API call to AI engine
  return {
    text: `AI response to: ${prompt}`,
    success: true,
  }
}