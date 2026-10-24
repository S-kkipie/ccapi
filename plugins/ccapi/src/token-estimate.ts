export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5)

const MEDIA_TOKENS = 1600

export const estimateRequestTokens = (req: { system?: unknown; messages: unknown; tools?: unknown }): number => {
  let media = 0
  const json = JSON.stringify([req.system ?? '', req.messages, req.tools ?? []], (key, value: unknown) => {
    if (key === 'data' && typeof value === 'string' && value.length > 256) {
      media += 1
      return ''
    }
    return value
  })
  return estimateTokens(json) + media * MEDIA_TOKENS
}
