// One session this chat has talked to, as Claude Code's own records show it.
export type SessionView = {
  name: string
  // From ~/.claude/sessions/<pid>.json; 'closed' when no live session carries the name.
  status: 'working' | 'idle' | 'closed'
  folder: string | null
  // From the session's transcript: its last reply's model, effort and context.
  model: string | null
  effort: string | null
  ctx: number | null
}

// One subagent the watched session spawned (an Agent call). Not a session: it never counts as one.
export type AgentView = {
  // '⟡' and the id of the tool call that spawned it; its messages carry it in `from`/`to`.
  key: string
  type: string
  description: string
  agentId: string | null
  status: 'running' | 'done'
  model: string | null
  tokens: number | null
  ms: number | null
  // When the transcript last said something about it, for the newest first.
  ts: number
}

// One message, read from the watched session's transcript. `from`/`to` are a
// session's name, an agent's key, or '@you' (the person) and '@self' (the watched session).
// `agent`: the key of the subagent the message goes to or comes from.
export type BusLine = { id: string; ts: number; from: string; to: string; text: string; agent?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-orchestra': {
      sessions: SessionView[]
      // This chat's subagents, the newest first.
      agents: AgentView[]
      // Whether agent cards and lines show; the [ ⟡ agents ] switch.
      showAgents: boolean
      bus: BusLine[]
      // Rows scrolled back from the newest message; 0 follows.
      logBack: number
      // The message open in the reader; '' reads the newest.
      selected: string
      readerOffset: number
      // The one session whose messages show; '' shows all.
      filter: string
      // Which page of session cards shows, 0 first.
      page: number
      paneUp: boolean
      // With the mode off: the sessions this chat talked to, and how many messages.
      heard: { names: string[]; count: number }
      // The watched session's own name, for its messages' labels.
      selfName: string
      // While the transcripts are still being read, so an empty pane says so instead of showing zeros.
      reading: boolean
    }
  }
}
