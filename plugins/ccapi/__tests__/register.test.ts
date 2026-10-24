import { expect, test } from 'claude-code/testing'

test('ccapi agent types are hidden from the model, others are not', async ($, on) => {
  on('agent.offer', () => ({ isOffered: true }))
  const hidden = await $.agent.offer({
    agent: 'ccapi:a12345678',
    description: 'ccapi request agent',
    source: 'plugin',
    provider: { plugin: 'ccapi', tier: 'user' },
  })
  const shown = await $.agent.offer({ agent: 'Explore', description: 'explore', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
  expect(hidden.isOffered).toBe(false)
  expect(shown.isOffered).toBe(true)
})
