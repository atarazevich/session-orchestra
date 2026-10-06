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

// One message, read from the watched session's transcript. `from`/`to` are a
// session's name, or '@you' (the person) and '@self' (the watched session).
export type BusLine = { id: string; ts: number; from: string; to: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    orchestra: {
      sessions: SessionView[]
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
    }
  }
}
