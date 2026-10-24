// In the server session every subagent is a ccapi request agent; the engine's injected
// attachment rows (environment, CLAUDE.md, user email, date, reminders) must not reach it.
export const shouldScrub = (type: string): boolean => type === 'attachment'
