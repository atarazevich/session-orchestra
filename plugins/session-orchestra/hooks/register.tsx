import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentView, BusLine, SessionView } from '../types'
import { demoData } from './demo'
import type { LogRow as DrawnRow } from './log'

const PANE = 'orchestra'
const POLL_MS = 15_000
const CHUNK_BYTES = 3_000_000 // under $.process.run's 4 MiB output cap
const OUTPUT_CAP = 4_194_304 // what $.process.run keeps of a program's output
const KEEP = 1000
const MAX_SESSIONS = 24
const MAX_AGENTS = 24
const DEMO = 'demo'
const YOU = '@you'
const SELF = '@self'
// Marks a subagent: before its name on screen, and before the spawning call's id in its key, so no session name meets it.
const AGENT = '⟡'

const sessions = atom({ plugin: 'session-orchestra', key: 'sessions' } as const, [])
const agents = atom({ plugin: 'session-orchestra', key: 'agents' } as const, [])
const showAgents = atom({ plugin: 'session-orchestra', key: 'showAgents' } as const, true)
const bus = atom({ plugin: 'session-orchestra', key: 'bus' } as const, [])
const logBack = atom({ plugin: 'session-orchestra', key: 'logBack' } as const, 0)
const selected = atom({ plugin: 'session-orchestra', key: 'selected' } as const, '')
const readerOffset = atom({ plugin: 'session-orchestra', key: 'readerOffset' } as const, 0)
const page = atom({ plugin: 'session-orchestra', key: 'page' } as const, 0)
const filter = atom({ plugin: 'session-orchestra', key: 'filter' } as const, '')
const heard = atom({ plugin: 'session-orchestra', key: 'heard' } as const, { names: [], count: 0 })
const paneUp = atom({ plugin: 'session-orchestra', key: 'paneUp' } as const, false)
const selfName = atom({ plugin: 'session-orchestra', key: 'selfName' } as const, '')
const reading = atom({ plugin: 'session-orchestra', key: 'reading' } as const, false)

const ACCENT = '#E8875B'
const HUB = '#6FC3DF'
const BOSS = '#C8A2F0'

// The status line's own scales (~/.claude/status_lines/status_line.py).
const EFFORT: Record<string, { bars: string; color: string }> = {
  low: { bars: '▂', color: 'gray' },
  medium: { bars: '▂▄', color: 'green' },
  high: { bars: '▂▄▆', color: 'yellowBright' },
  xhigh: { bars: '▂▄▆█', color: '#FF8700' },
  max: { bars: '▂▄▆█', color: 'redBright' },
}
const DUMB_ZONE = 40
const ctxColor = (pct: number) =>
  pct < 10 ? 'gray' : pct < 20 ? 'green' : pct < 30 ? 'yellow' : pct < DUMB_ZONE ? '#FF8700' : 'red'

// A session's state, and an agent's; the colour is the card's border too.
const STATE: Record<SessionView['status'] | AgentView['status'], { glyph: string; word: string; color: string }> = {
  working: { glyph: '◐', word: 'working', color: ACCENT },
  idle: { glyph: '○', word: 'idle', color: 'gray' },
  closed: { glyph: '✕', word: 'closed', color: 'gray' },
  running: { glyph: '◐', word: 'running', color: ACCENT },
  done: { glyph: '✓', word: 'done', color: 'gray' },
}

// One live session as Claude Code records it in ~/.claude/sessions/<pid>.json.
type Registered = { sessionId: string; cwd: string; name: string; status: string; messagingSocketPath?: string }
type Block = {
  type: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: string | Block[]
}
type Row = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  effort?: string
  attachment?: { type?: string; prompt?: string }
  // A tool's outcome, on the row with its tool_result; an Agent call's says launched in the background, or done.
  toolUseResult?: string | {
    status?: string
    agentId?: string
    resolvedModel?: string
    totalTokens?: number
    totalDurationMs?: number
    content?: Block[]
  }
  message?: {
    model?: string
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    content?: string | Block[]
  }
}
// The subagents of one watch by key, filled in as their rows are read.
type Roster = Map<string, AgentView>

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const dayLabel = (ts: number) => {
  const d = new Date(ts)
  const label = `${d.toDateString().slice(0, 3)} ${d.getDate()} ${d.toDateString().slice(4, 7)}`
  return d.toDateString() === new Date().toDateString() ? `Today · ${label}` : label
}
// 106 s → 1m 46s
const took = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5; an Agent call's alias opus → Opus
const modelName = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id)
  if (!m) return /^(opus|sonnet|haiku|fable)$/.test(id) ? id.replace(/^./, c => c.toUpperCase()) : id
  const family = (m[1] ?? '').replace(/^./, c => c.toUpperCase())
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
// Normalises herdr tab titles: "◐ backend ⑂" → "backend".
const plainTitle = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*⑂$/, '').trim()
function inline(line: string): { text: string; isBold: boolean; isCode: boolean }[] {
  return line
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map(part =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { text: part.slice(2, -2), isBold: true, isCode: false }
        : part.startsWith('`') && part.endsWith('`') && part.length > 2
          ? { text: part.slice(1, -1), isBold: false, isCode: true }
          : { text: part, isBold: false, isCode: false },
    )
}
type LogRow = { day: string } | { line: BusLine }

// The list's rows: a date row opens each day.
function withDays(listed: BusLine[]): LogRow[] {
  const rows: LogRow[] = []
  for (const l of listed) {
    const day = dayLabel(l.ts)
    if (rows.findLast(r => 'day' in r)?.day !== day) rows.push({ day })
    rows.push({ line: l })
  }
  return rows
}

// Word-wraps text to `width` columns, keeping paragraphs and bullets.
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    const indent = /^\s*([-*•]|\d+\.)\s/.test(para) ? '  ' : ''
    let line = ''
    for (const word of para.trim().split(/\s+/)) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        out.push(line)
        line = indent + word
      }
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

// Which session this one watches. Unset: the mode is off here.
let watching: { transcript: string; sessionId: string; isOwn: boolean } | null = null
let timer: { cancel: () => void } | null = null
// Bumped on every switch; a poll or a history read started before it writes nothing.
let generation = 0
// The generation whose poll is running, so polls never overlap.
let polling = -1
// The generation of a poll skipped while another ran: the running one runs once more when it ends.
let again = -1
// Last drawn geometry, for the scroll hook to tell the log from the reader.
let geometry = { readerTop: Infinity, maxBack: 0, maxReader: 0 }
// Earlier transcripts are read once (null until then); the live one from where the last poll stopped.
let history: BusLine[] | null = null
let live = { offset: 0, lines: [] as BusLine[] }
// The watched session's subagents, a new one on every switch.
let roster: Roster = new Map()
// A session's model, effort and context, kept until it works again.
const details = new Map<string, Pick<SessionView, 'model' | 'effort' | 'ctx'>>()

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? '~'
}

async function registry($: EngineInterface): Promise<Registered[]> {
  const dir = `${await home($)}/.claude/sessions`
  const found: Registered[] = []
  try {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const one = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Registered
        if (one.name && one.sessionId) found.push(one)
      } catch {
        // A file mid-write: next poll.
      }
    }
  } catch {
    // No registry: every card reads closed.
  }
  return found
}

// herdr's panes by id, when herdr runs here; `herdr agent prompt <pane>` names its target that way.
async function herdrPanes($: EngineInterface): Promise<Record<string, string>> {
  try {
    const listed = await $.process.run(['herdr', 'agent', 'list'], { timeoutMs: 5_000 })
    if (listed.exitCode !== 0) return {}
    const agents: { pane_id: string; terminal_title_stripped: string }[] = JSON.parse(listed.stdout).result.agents
    return Object.fromEntries(agents.map(a => [a.pane_id, plainTitle(a.terminal_title_stripped)]))
  } catch {
    return {}
  }
}

// Names an address the way the live sessions call themselves: a socket through the registry, a herdr pane by its title.
async function namer($: EngineInterface, found: Registered[]) {
  const panes = await herdrPanes($)
  return (address: string) => {
    if (address.startsWith('uds:')) return found.find(s => s.messagingSocketPath === address.slice(4))?.name ?? address
    if (address.startsWith('herdr:')) return panes[address.slice(6)] ?? address.slice(6)
    return address
  }
}

// FNV-1a of the full text, so two messages that start alike keep apart ids.
const hash = (s: string) => {
  let x = 0x811c9dc5
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193)
  return (x >>> 0).toString(36)
}

// The same message from and to the same sessions within 2 minutes shows once; an agent's, once ever
// (its result can arrive both queued mid-turn and as its own row).
function dedupe(lines: BusLine[]): BusLine[] {
  const last = new Map<string, number>()
  return lines.filter(l => {
    const key = `${l.from}|${l.to}|${l.agent ? hash(l.text) : oneLine(l.text).slice(0, 60)}`
    const twin = last.get(key)
    if (twin !== undefined && (l.agent || l.ts - twin < 120_000)) return false
    last.set(key, l.ts)
    return true
  })
}

// The text blocks of a tool's result, joined.
const textOf = (content: string | Block[] | undefined) =>
  typeof content === 'string' ? content : (content ?? []).flatMap(b => (b.type === 'text' && b.text ? [b.text] : [])).join('\n\n')

// A background agent's end: <task-notification><task-id>{agentId}</task-id><tool-use-id>…</tool-use-id>
// <status>…</status><summary>…</summary><result>…</result><usage>…</usage>. A background shell's has a b… task-id.
function notified(note: string) {
  const tag = (name: string, from = note) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(from)?.[1]
  const agentId = tag('task-id')
  if (!agentId || !isAgentId(agentId)) return null
  const toolId = tag('tool-use-id')
  // the usage follows the result, which may quote its tags
  const usage = note.slice(note.lastIndexOf('</result>') + 1)
  const count = (name: string) => {
    const n = Number(tag(name, usage))
    return Number.isFinite(n) ? n : null
  }
  return {
    ref: toolId ? AGENT + toolId : agentId,
    agentId,
    // the result is last, and may quote any tag
    text: /<result>([\s\S]*)<\/result>/.exec(note)?.[1] ?? tag('summary') ?? '',
    tokens: count('subagent_tokens'),
    ms: count('duration_ms'),
  }
}

// An object's fields that say something.
const filled = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')) as Partial<T>

// Tells the roster what a row says of an agent: `ref` is its key, or its agentId where the row names only that.
// Answers the agent's key, or undefined for an agent the roster cannot place. Rows come out of order (the earlier
// transcripts are read last), so a newer row's word wins, and an older one only fills what is still unknown;
// `sure` wins whenever it comes.
function tell(roster: Roster, ref: string, ts: number, news: Partial<AgentView>, sure: Partial<AgentView> = {}) {
  // A spawning call keeps what is said under its id. An agent resumed by SendMessage ends under that call's id:
  // its agentId leads back to the call that spawned it. Not read yet, it waits under its own ref for `settle`.
  const spawnedAs = (id: string | null | undefined) => (id ? [...roster.values()].find(a => a.type && a.agentId === id)?.key : undefined)
  const key = roster.get(ref)?.type ? ref : (spawnedAs(news.agentId) ?? (ref.startsWith(AGENT) || news.agentId ? ref : undefined))
  if (!key) return undefined
  const was = roster.get(key) ?? { key, type: '', description: '', agentId: null, status: 'running', model: null, tokens: null, ms: null, ts }
  roster.set(key, { ...(ts >= was.ts ? { ...was, ...filled(news), ts } : { ...was, ...filled(news), ...filled(was) }), ...filled(sure) })
  return key
}

// Reads a transcript's messages; what it says of this chat's subagents goes into `roster`, and their lines carry their key.
function parseBus(jsonl: string, nameOf: (address: string) => string, roster: Roster): BusLine[] {
  const lines: BusLine[] = []
  const push = (ts: number, from: string, to: string, text: string, agent?: string) => {
    lines.push({ id: `${ts}|${from}|${to}|${hash(text)}`, ts, from, to, text: text.trim(), ...(agent ? { agent } : {}) })
  }

  for (const raw of jsonl.split('\n')) {
    let row: Row
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const ts = Date.parse(row.timestamp ?? '')
    if (Number.isNaN(ts)) continue
    // A prompt or a session's message: its own user row when the session was idle (a session's
    // message is stored isMeta), a queued_command attachment when it arrived mid-turn.
    const queued = row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt : undefined
    const content = row.message?.content
    const said =
      queued ??
      (row.type !== 'user' || content === undefined ? undefined
        : typeof content === 'string' ? content
        : content.some(b => b.type === 'tool_result') ? undefined
        : content.find(b => b.type === 'text')?.text)
    if (said !== undefined) {
      const peer = /<cross-session-message[^>]*from-name="([^"]+)"[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(said)
      const note = /^\s*<task-notification>/.test(said) ? notified(said) : null
      const noted = note && tell(roster, note.ref, ts, { agentId: note.agentId, status: 'done', tokens: note.tokens, ms: note.ms })
      if (note) {
        if (noted) push(ts, noted, SELF, note.text, noted)
      } else if (peer) push(ts, nameOf(peer[1] ?? '?'), SELF, peer[2] ?? '')
      else if ((queued !== undefined || !row.isMeta) && !/^\s*</.test(said) && !said.startsWith('This session is being continued'))
        push(ts, YOU, SELF, said)
    }

    // An Agent call's result: launched in the background (its end comes as a task-notification), done, or failed.
    if (row.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const key = AGENT + block.tool_use_id
        const result = typeof row.toolUseResult === 'object' ? row.toolUseResult : undefined
        if (result?.agentId && result.status === 'async_launched') {
          // the model it runs on outranks the alias its call asked for
          tell(roster, key, ts, { agentId: result.agentId, status: 'running' }, { model: result.resolvedModel ? modelName(result.resolvedModel) : null })
        } else if (result?.agentId) {
          tell(roster, key, ts, { agentId: result.agentId, status: 'done', tokens: result.totalTokens ?? null, ms: result.totalDurationMs ?? null })
          push(ts, key, SELF, textOf(result.content ?? block.content), key)
        } else if (block.is_error && roster.has(key)) {
          // a failed call is an agent's only when the roster holds its call
          tell(roster, key, ts, { status: 'done' })
          push(ts, key, SELF, textOf(block.content), key)
        }
      }
    }

    if (row.type !== 'assistant' || content === undefined || typeof content === 'string') continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const input = block.input ?? {}
      // A subagent this chat spawns: older transcripts call the tool Task.
      if ((block.name === 'Agent' || block.name === 'Task') && block.id) {
        const key = AGENT + block.id
        const model = typeof input.model === 'string' ? modelName(input.model) : null
        tell(roster, key, ts, { type: String(input.subagent_type ?? 'general-purpose'), description: String(input.description ?? ''), status: 'running', model })
        push(ts, SELF, key, String(input.prompt ?? ''), key)
      }
      // A message to an agent's id joins that agent.
      if (block.name === 'SendMessage' && typeof input.to === 'string') {
        const agent = isAgentId(input.to) ? tell(roster, input.to, ts, { agentId: input.to }) : undefined
        push(ts, SELF, agent ?? nameOf(input.to), String(input.message ?? ''), agent)
      }
      if (block.name === 'Bash' && typeof input.command === 'string') {
        for (const m of input.command.matchAll(/herdr agent prompt (w\d+:p\w+) "((?:[^"\\]|\\.)*)"/g)) {
          const text = (m[2] ?? '').replace(/\\"/g, '"')
          if (text !== '/compact') push(ts, SELF, nameOf(`herdr:${m[1] ?? ''}`), text)
        }
      }
    }
  }
  return lines
}

// The cards: every agent whose spawning call was read. An agent first heard of before its call (the earlier
// transcripts are read last) folds into that call's card by agentId; one whose call was never read has no card,
// nor lines. Answers the cards, the newest first, and the lines with each agent's key turned into its card's.
function settle(roster: Roster, lines: BusLine[]) {
  const typed = [...roster.values()].filter(a => a.type)
  const cards = new Map(typed.map(a => [a.key, a]))
  const cardOf = new Map(typed.map(a => [a.key, a.key]))
  for (const a of roster.values()) {
    const home = a.type ? undefined : typed.find(t => t.agentId !== null && t.agentId === a.agentId)
    const card = home && cards.get(home.key)
    if (!home || !card) continue
    cards.set(home.key, a.ts >= card.ts ? { ...card, ...filled(a), key: card.key } : { ...card, ...filled(a), ...filled(card) })
    cardOf.set(a.key, home.key)
  }
  const placed = lines.flatMap(l => {
    const key = l.agent && cardOf.get(l.agent)
    if (!l.agent) return [l]
    if (!key) return []
    const as = (who: string) => (who === l.agent ? key : who)
    return [{ ...l, from: as(l.from), to: as(l.to), agent: key }]
  })
  return { agents: [...cards.values()].sort((a, b) => b.ts - a.ts), lines: placed }
}

// An agent's name after ⟡: its type and the end of the id of the call that spawned it.
const agentName = (a: AgentView) => `${a.type || 'agent'}·${a.key.slice(-4)}`
// The lines the pane shows: with the [ ⟡ agents ] switch off, no agent's.
const onScreen = (lines: BusLine[], isShowing: boolean) => (isShowing ? lines : lines.filter(l => !l.agent))

// Reads a file from a byte offset to its last complete line; answers the text and the new offset.
// $.process.run keeps the first OUTPUT_CAP bytes of what a program writes, so a long file takes several reads.
async function readFrom($: EngineInterface, file: string, offset: number) {
  let text = ''
  // Inside a line longer than one read: its rest, up to the next newline, is dropped.
  let skipping = false
  for (;;) {
    // a read that times out rejects: keep what was read so far
    const out = await $.process.run(['tail', '-c', `+${offset + 1}`, file], { timeoutMs: 20_000 }).catch(() => null)
    if (!out || out.exitCode !== 0) break
    const cut = out.stdout.lastIndexOf('\n') + 1
    if (cut === 0) {
      if (!out.isStdoutTruncated) break
      // a full read of one long line: step past its bytes
      offset += OUTPUT_CAP
      skipping = true
      continue
    }
    const whole = out.stdout.slice(0, cut)
    text += skipping ? whole.slice(whole.indexOf('\n') + 1) : whole
    skipping = false
    // whole lines of UTF-8 encode back to exactly the bytes they were read from
    offset += new TextEncoder().encode(whole).length
    if (!out.isStdoutTruncated) break
  }
  return { text, offset }
}

// A compacted session goes on in a new transcript; its summary names the one before.
async function chainOf($: EngineInterface, file: string) {
  const chain = [file]
  for (let oldest = file; chain.length < 6; ) {
    // a read that times out ends the chain where it is
    const head = await $.process.run(['head', '-c', '400000', oldest]).catch(() => null)
    const before = head && /read the full transcript at: (\/[^\s"\\]+\.jsonl)/.exec(head.stdout)?.[1]
    if (!before || chain.includes(before)) break
    chain.unshift(before)
    oldest = before
  }
  return chain
}

// A session's transcript sits under its folder, spelled the way Claude Code spells project folders.
const transcriptPath = (root: string, s: Registered) =>
  `${root}/.claude/projects/${s.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${s.sessionId}.jsonl`

// claude-<family>-<major>… or claude-<major>-…-<family>…: 200k for Haiku and up to major 4, 1M after.
const contextWindow = (id: string) => {
  const major = /claude-(?:[a-z]+-)?(\d+)/.exec(id)?.[1]
  return major && (id.includes('haiku') || Number(major) <= 4) ? 200_000 : 1_000_000
}

// Model, effort and context of a session's last reply, from its transcript's tail.
async function detailOf($: EngineInterface, root: string, s: Registered) {
  // a read that times out leaves the session's last known detail
  const tail = await $.process.run(['tail', '-c', '300000', transcriptPath(root, s)], { timeoutMs: 5_000 }).catch(() => null)
  if (!tail) return null
  const out: Pick<SessionView, 'model' | 'effort' | 'ctx'> = { model: null, effort: null, ctx: null }
  for (const raw of tail.stdout.split('\n').reverse()) {
    if (out.model && out.effort) break
    if (!raw.includes('"usage"') && !raw.includes('"effort"')) continue
    let row: Row
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    if (!out.effort && row.effort) out.effort = row.effort
    const usage = row.message?.usage
    if (!out.model && row.type === 'assistant' && row.message?.model && usage) {
      const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      const window = contextWindow(row.message.model)
      out.model = modelName(row.message.model)
      out.ctx = Math.round((used * 100) / window)
    }
  }
  return out
}

const isAgentId = (who: string) => /^a[0-9a-f]{15,}$/.test(who)

// Never rejects and never overlaps: a failed poll waits for the next, one from before a switch writes nothing.
async function poll($: EngineInterface) {
  const w = watching
  const my = generation
  if (!w || w.sessionId === DEMO) return
  if (polling === my) {
    again = my
    return
  }
  polling = my
  try {
    const root = await home($)
    const found = await registry($)
    const nameOf = await namer($, found)

    const { text, offset } = await readFrom($, w.transcript, live.offset)
    if (my !== generation) return
    live = { offset, lines: [...live.lines, ...parseBus(text, nameOf, roster)].slice(-KEEP) }
    const hasHistory = history !== null
    const settled = settle(roster, [...(history ?? []), ...live.lines])
    const lines = dedupe(settled.lines).slice(-KEEP)

    // The sessions this chat has talked to, the latest first; an agent is not one.
    const lastTs = new Map<string, number>()
    for (const l of lines) for (const who of [l.from, l.to]) if (!l.agent && who !== YOU && who !== SELF && !isAgentId(who)) lastTs.set(who, l.ts)
    const names = [...lastTs.keys()].sort((a, b) => (lastTs.get(b) ?? 0) - (lastTs.get(a) ?? 0)).slice(0, MAX_SESSIONS)
    const views: SessionView[] = []
    for (const name of names) {
      const s = found.find(r => r.name === name && r.sessionId !== w.sessionId)
      const status: SessionView['status'] = !s ? 'closed' : s.status === 'busy' ? 'working' : 'idle'
      const fresh = s && (status === 'working' || !details.has(s.sessionId)) ? await detailOf($, root, s) : null
      if (s && fresh) details.set(s.sessionId, fresh)
      const detail = (s && details.get(s.sessionId)) || { model: null, effort: null, ctx: null }
      views.push({ name, status, folder: s ? baseName(s.cwd) : null, ...detail })
    }
    if (my !== generation) return
    await update($, sessions, () => views)
    await update($, agents, () => settled.agents)

    const before = await read($, bus)
    const only = await read($, filter)
    const back = await read($, logBack)
    const isShowing = await read($, showAgents)
    if (my !== generation) return
    await update($, bus, () => lines)
    // A reader scrolled back keeps its place: the rows new messages add to the list, day rows too, push it down.
    const newest = before[before.length - 1]?.ts ?? 0
    const listed = onScreen(lines, isShowing).filter(l => !only || l.from === only || l.to === only)
    const added = withDays(listed).length - withDays(listed.filter(l => l.ts <= newest)).length
    if (my !== generation) return
    if (newest > 0 && added > 0 && back > 0) await update($, logBack, n => n + added)
    // the first list that holds the earlier transcripts ends the reading
    if (hasHistory && (await read($, reading))) await update($, reading, () => false)
  } catch {
    // the next poll tries again
  } finally {
    if (polling === my) {
      polling = -1
      if (again === my) {
        again = -1
        await poll($)
      }
    }
  }
}

// Counts one more message with `who` while the mode is off, for the hint under the prompt.
async function hear($: EngineInterface, who: string) {
  if (watching || isAgentId(who)) return
  await update($, heard, was => ({ names: was.names.includes(who) ? was.names : [...was.names, who], count: was.count + 1 }))
}

// On start with the mode off: what this session's transcript already holds.
async function scanOwn($: EngineInterface) {
  const transcript = await transcriptOf($, await $.session.id())
  if (!transcript) return
  // the last 3 MB is enough to know whether this chat talks to other sessions
  const tail = await $.process.run(['tail', '-c', String(CHUNK_BYTES), transcript], { timeoutMs: 10_000 })
  // agents' lines count as the pane would show them
  const scanned: Roster = new Map()
  const lines = onScreen(dedupe(settle(scanned, parseBus(tail.stdout, a => a, scanned)).lines), await read($, showAgents)).filter(l => l.from !== YOU)
  const names = [...new Set(lines.flatMap(l => (l.agent ? [] : [l.from, l.to])))].filter(n => n !== YOU && n !== SELF && !isAgentId(n) && !n.startsWith('herdr:'))
  await update($, heard, () => ({ names, count: lines.length }))
}

// Opens the pane and records whether it is up: the plugin's own calls do not pass its own hooks.
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'orchestra' })
  await update($, paneUp, () => opened.isPlaced)
  return opened
}

async function transcriptOf($: EngineInterface, sessionId: string): Promise<string | null> {
  const found = await $.process.run(['find', `${await home($)}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`])
  return found.stdout.split('\n')[0]?.trim() || null
}

// 'superseded': a later switch, demo or off took over meanwhile, and the caller does nothing.
async function turnOn($: EngineInterface, sessionId: string): Promise<'on' | 'missing' | 'superseded'> {
  const entry = generation
  const isOwn = sessionId === (await $.session.id())
  const transcript = await transcriptOf($, sessionId)
  // an off, demo or switch made while the transcript was looked up wins
  if (entry !== generation) return 'superseded'
  if (!transcript) return 'missing'
  // Stop the old watch before the new one starts, so nothing reads the new transcript from the old offset.
  timer?.cancel()
  timer = null
  const my = ++generation
  history = null
  live = { offset: 0, lines: [] }
  roster = new Map()
  watching = { transcript, sessionId, isOwn }
  try {
    await update($, reading, () => true)
    const found = await registry($)
    const own = found.find(s => s.sessionId === sessionId)?.name
    await update($, selfName, () => (!isOwn && own) || 'this chat')
    // switched again meanwhile: that switch owns the watch
    if (my !== generation) return 'superseded'
    // The current transcript first, so the pane fills at once; a compacted session's earlier ones join behind it.
    timer = $.clock.every(POLL_MS, () => poll($))
    await poll($)
    if (my !== generation) return 'superseded'
    void readEarlier($, transcript, found, my)
    return 'on'
  } catch (err) {
    // a failed start leaves no watch and no "Reading…" behind, so the next try starts afresh
    if (my === generation) {
      watching = null
      timer?.cancel()
      timer = null
      await update($, reading, () => false)
    }
    throw err
  }
}

// The transcripts a compacted session left behind, read once, oldest first.
// None of its reads reject, and the poll that lists them ends the reading.
async function readEarlier($: EngineInterface, transcript: string, found: Registered[], my: number) {
  const nameOf = await namer($, found)
  const chain = await chainOf($, transcript)
  // the roster of this watch, not of one a later switch starts
  const mine = roster
  const earlier: BusLine[] = []
  for (const file of chain.slice(0, -1)) {
    const got = await readFrom($, file, 0)
    earlier.push(...parseBus(got.text, nameOf, mine))
  }
  if (my !== generation) return
  history = earlier
  await poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orchestra',
      description: 'Orchestrator view: on [session id] · off · (no argument) open the pane',
    }).catch(() => {
      // the session starts all the same
    })
    // In the background, so the full history read never holds up the first prompt.
    void (async () => {
      const own = await $.session.id()
      // the [ ⟡ agents ] switch, as this session left it
      if ((await $.store.get(`agents:${own}`)) === false) await update($, showAgents, () => false)
      const target = await $.store.get(`on:${own}`)
      const state = typeof target === 'string' ? await turnOn($, target) : 'missing'
      if (state === 'on') await openPane($)
      else if (state === 'missing') await scanOwn($)
    })().catch(() => {
      // a later /orchestra tries again
    })

    return next(e)
  })

  // With the mode off, every message to or from another session counts toward the hint.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const to = (e as unknown as { to?: unknown }).to
    if (typeof to === 'string') await hear($, to)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
      const from = /from-name="([^"]+)"/.exec(e.text)?.[1]
      if (from) await hear($, from)
    }
    return next(e)
  })

  // The person closing the pane (its ✕, Esc) reaches this hook; the hint line reads the result.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, paneUp, () => false)
    return next(e)
  })

  // The hint line under the prompt: while the pane is not up and this chat talks to other
  // sessions, it ends with a dim note that opens the pane when clicked.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    // read through state, so closing or opening the pane redraws the footer
    if (await read($, paneUp)) return next(e)
    const off = watching ? null : await read($, heard)
    const n = off ? off.names.length : (await read($, sessions)).filter(v => v.status !== 'closed').length
    const isShowing = await read($, showAgents)
    const count = off ? off.count : onScreen(await read($, bus), isShowing).length
    if (off ? !n : !n && !count) return next(e)
    const note = `◆ ${n} session${n === 1 ? '' : 's'} ⇄ ${count}`
    const { Box, Button, Text } = $.ui.resolve(e)
    const hint = e.props.hint.replace(/^\(shift\+tab to cycle\)\s*·?\s*/, '')
    return (
      <Box flexDirection="row" gap={1}>
        {/* the engine joins its mode label to this tree with " · ", so the cycle tip goes */}
        {hint !== '' && <Text dimColor>{`${hint} ·`}</Text>}
        <Button key="orchestra-open" plain dimColor onPress={async () => {
          try {
            const own = await $.session.id()
            if (!watching) {
              const state = await turnOn($, own)
              if (state === 'superseded') return
              if (state === 'on') await $.store.set(`on:${own}`, own)
            }
            await openPane($)
          } catch {
            // nothing to show: the next press tries again
          }
        }}>
          {note}
        </Button>
      </Box>
    )
  })

  on('command.run', { command: 'orchestra' }, async ($, e) => {
    const own = await $.session.id()
    const [verb, arg] = e.args.trim().split(/\s+/)

    if (verb === 'off') {
      watching = null
      generation++
      await update($, reading, () => false)
      timer?.cancel()
      timer = null
      await $.store.delete(`on:${own}`)
      await $.ui.close({ id: PANE })
      await update($, paneUp, () => false)
      return { text: 'Orchestra is off in this session.' }
    }
    // Made-up sessions and messages, for a screenshot that shows nobody's work.
    if (verb === 'demo') {
      timer?.cancel()
      timer = null
      generation++
      watching = { transcript: '', sessionId: DEMO, isOwn: true }
      await update($, reading, () => false)
      const demo = demoData(await $.clock.now())
      await update($, sessions, () => demo.sessions)
      await update($, agents, () => [])
      await update($, bus, () => demo.bus)
      await update($, selfName, () => 'this chat')
      // open on the long message, so the reader shows what it does
      await update($, selected, () => demo.bus.find(l => l.text.startsWith('POST /checkout is **live**'))?.id ?? '')
      await update($, filter, () => '')
      await update($, logBack, () => 0)
      await openPane($)
      return { text: 'Orchestra shows made-up sessions. /orchestra on goes back to this session.' }
    }
    if (verb === 'on') {
      const target = arg || own
      const state = await turnOn($, target).catch(() => null)
      if (!state) return { text: `Orchestra could not turn on for session ${target}. Try /orchestra on again.` }
      if (state === 'missing') return { text: `No transcript found for session ${target}.` }
      if (state === 'superseded') return { text: 'A later /orchestra took over.' }
      await $.store.set(`on:${own}`, target)
      await openPane($)
      const label = await read($, selfName)
      return { text: `Orchestra is on, watching ${label}. It comes back on when this session resumes.` }
    }
    if (!watching) return { text: 'Orchestra is off here. Type /orchestra on to make this session an orchestrator.' }
    await poll($)
    await openPane($)
    return { text: 'Orchestra opened.' }
  })

  // A click on a row of the message list (hooks/log.tsx) opens that message.
  on('ui.message', { element: 'log' }, async ($, e) => {
    const id = (e.data as { pick?: unknown }).pick
    if (typeof id === 'string') {
      await update($, selected, () => id)
      await update($, readerOffset, () => 0)
    }
    return {}
  })

  // The pane never scrolls as a whole: the sessions stay, the log and the reader scroll themselves.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const overReader = (e.pointer?.row ?? -1) >= geometry.readerTop
    if (overReader) await update($, readerOffset, n => clamp(n + e.by, 0, geometry.maxReader))
    else await update($, logBack, n => clamp(n - e.by, 0, geometry.maxBack))

    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(44, e.props.bodyColumns ?? 64)
    const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const views = await read($, sessions)
    const spawnedViews = await read($, agents)
    const isShowing = await read($, showAgents)
    // every agent names its lines; the newest MAX_AGENTS get cards
    const shownAgents = isShowing ? spawnedViews.slice(0, MAX_AGENTS) : []
    // With the switch off, no agent's card or line shows anywhere.
    const lines = onScreen(await read($, bus), isShowing)
    const self = await read($, selfName)
    const isReading = await read($, reading)
    const working = views.filter(v => v.status === 'working').length
    const agentNames = new Map(spawnedViews.map(a => [a.key, `${AGENT} ${agentName(a)}`]))
    const label = (who: string) => (who === YOU ? 'you' : who === SELF ? self || 'this chat' : agentNames.get(who) ?? who)
    const colorOf = (who: string) => (who === YOU ? BOSS : who === SELF ? HUB : ACCENT)

    // Each section opens with a full-width rule carrying its name; a blank row before the lower two.
    const header = (title: string, count: string, right?: JSX.Element) => (
      <Box flexDirection="row" height={1} width={width} overflow="hidden">
        <Box flexShrink={0}>
          <Text dimColor>──</Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1} marginX={1}>
          <Text bold>{title}</Text>
          {count !== '' && <Text dimColor>{count}</Text>}
        </Box>
        <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
          <Text dimColor wrap="wrap">{'─'.repeat(width)}</Text>
        </Box>
        {right && (
          <Box flexShrink={0} marginX={1}>
            {right}
          </Box>
        )}
        <Box flexShrink={0}>
          <Text dimColor>──</Text>
        </Box>
      </Box>
    )
    const gap = 1
    const spacer = (k: string) => <Box key={k} height={1}><Text> </Text></Box>

    // ── SESSIONS: cards in pages, 2 wide, the agents' after the sessions'; one row of chips when short of room
    const open = views.filter(v => v.status !== 'closed')
    const grid: (SessionView | AgentView)[] = [...open, ...shownAgents]
    const perPage = height >= 44 ? 6 : height >= 32 ? 4 : 0
    const pages = perPage ? Math.max(1, Math.ceil(grid.length / perPage)) : 1
    const at = clamp(await read($, page), 0, pages - 1)
    const shownViews = perPage ? grid.slice(at * perPage, at * perPage + perPage) : grid
    const cardWidth = Math.floor(width / 2)
    const inner = cardWidth - 4
    const LABEL = 9 // "47% dumb"

    // A session's name shows only its messages; again, or [ all ], shows every one.
    const only = await read($, filter)
    const pick = async (name: string) => {
      await update($, filter, f => (f === name ? '' : name))
      await update($, selected, () => '')
      await update($, logBack, () => 0)
    }
    // A card: its name, which shows only its messages, and its state; its model and an aside; a row of its own.
    const frame = (id: string, title: string, status: keyof typeof STATE, model: JSX.Element, aside: string, foot: JSX.Element) => {
      const state = STATE[status]
      return (
        <Box key={id} borderStyle="round" borderColor={id === only ? HUB : state.color} flexDirection="column" width={cardWidth} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1} height={1} overflow="hidden">
              <Button key={`s-${id}`} plain onPress={() => pick(id)}>
                {clip(title, Math.max(4, inner - state.word.length - 3))}
              </Button>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text color={state.color}>{state.glyph} {state.word}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {model}
            </Box>
            <Box flexShrink={1} marginLeft={1}>
              <Text dimColor wrap="truncate-end">{aside}</Text>
            </Box>
          </Box>
          {foot}
        </Box>
      )
    }
    const tokens = new Intl.NumberFormat('en', { notation: 'compact' })
    // A session's card ends in its context bar; an agent's, in the tokens and time it spent.
    const card = (v: SessionView | AgentView) => {
      if ('key' in v) {
        const spent = [v.tokens === null ? '' : `${tokens.format(v.tokens)} tokens`, v.ms === null ? '' : took(v.ms)].filter(Boolean).join(' · ')
        const model = <Text color={v.model ? 'cyan' : 'gray'}>{v.model ?? '—'}</Text>
        return frame(v.key, `${AGENT} ${agentName(v)}`, v.status, model, v.description, <Text dimColor wrap="truncate-end">{spent || '–'}</Text>)
      }
      const pct = v.ctx ?? 0
      const barWidth = Math.max(4, inner - LABEL)
      const filled = v.ctx === null ? 0 : Math.round((barWidth * pct) / 100)
      const mark = Math.round((barWidth * DUMB_ZONE) / 100)
      const empty = Array.from({ length: barWidth - filled }, (_, i) => (filled + i === mark ? '╎' : '┄')).join('')
      const effort = v.effort ? EFFORT[v.effort] : undefined
      const isDumb = v.ctx !== null && pct >= DUMB_ZONE
      const model = (
        <Box flexDirection="row" gap={1}>
          <Text color={v.model ? 'cyan' : 'gray'}>{v.model ?? '—'}</Text>
          {effort && <Text color={effort.color}>{effort.bars}</Text>}
        </Box>
      )
      const bar = (
        <Box flexDirection="row">
          <Text color={ctxColor(pct)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{empty}</Text>
          <Box width={LABEL} justifyContent="flex-end">
            <Text color={v.ctx === null ? 'gray' : ctxColor(pct)} bold={isDumb}>
              {v.ctx === null ? '–' : isDumb ? `${pct}% dumb` : `${pct}%`}
            </Text>
          </Box>
        </Box>
      )
      return frame(v.name, `✻ ${v.name}`, v.status, model, v.folder ? `📁 ${v.folder}` : '', bar)
    }

    const pager =
      pages > 1 ? (
        <Box flexDirection="row" gap={1}>
          {at > 0 ? (
            <Button key="prev" plain onPress={() => update($, page, n => Math.max(0, n - 1))}>‹</Button>
          ) : (
            <Text dimColor>‹</Text>
          )}
          {Array.from({ length: pages }, (_, i) =>
            i === at ? (
              <Text key={`p${i}`} bold color={HUB}>{`${i + 1}`}</Text>
            ) : (
              <Button key={`p${i}`} plain dimColor onPress={() => update($, page, () => i)}>{`${i + 1}`}</Button>
            ),
          )}
          {at < pages - 1 ? (
            <Button key="next" plain onPress={() => update($, page, n => Math.min(pages - 1, n + 1))}>›</Button>
          ) : (
            <Text dimColor>›</Text>
          )}
        </Box>
      ) : undefined

    const sessionRows = 1 + (grid.length === 0 ? 1 : perPage ? Math.ceil(shownViews.length / 2) * 5 : 1)
    const countsText = `${open.length} open${working ? ` · ${working} working` : ''}`
    // The switch, on the Messages line, shows once this chat has spawned an agent; off, it hides their cards and lines.
    const flip = async () => {
      const own = await $.session.id()
      const next = !(await read($, showAgents))
      await update($, showAgents, () => next)
      await $.store.set(`agents:${own}`, next)
      await update($, filter, f => (!next && f.startsWith(AGENT) ? '' : f))
      await update($, page, () => 0)
      await update($, logBack, () => 0)
    }
    const toggle =
      spawnedViews.length > 0 ? (
        <Button key="agents" dimColor={!isShowing} onPress={flip}>{`${AGENT} agents`}</Button>
      ) : undefined
    const sessionsSection = (
      <Box flexDirection="column" height={sessionRows}>
        {header('Sessions', countsText, pager)}
        {grid.length === 0 ? (
          <Text dimColor>{isReading ? 'Reading the transcripts…' : 'None open. A session shows here once this chat messages it or hears from it.'}</Text>
        ) : perPage ? (
          Array.from({ length: Math.ceil(shownViews.length / 2) }, (_, r) => (
            <Box key={`row${r}`} flexDirection="row">
              {shownViews.slice(r * 2, r * 2 + 2).map(card)}
            </Box>
          ))
        ) : (
          <Box flexDirection="row" gap={2} height={1} overflow="hidden">
            {grid.map(v => (
              <Box key={'key' in v ? v.key : v.name} flexDirection="row" gap={1}>
                <Text color={STATE[v.status].color}>{STATE[v.status].glyph} {'key' in v ? `${AGENT} ${agentName(v)}` : v.name}</Text>
                {!('key' in v) && <Text color={ctxColor(v.ctx ?? 0)}>{v.ctx === null ? '–' : `${v.ctx}%`}</Text>}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )

    // ── MESSAGE: the picked message in full, or the newest one
    const listed = only ? lines.filter(l => l.from === only || l.to === only) : lines
    const pickedId = await read($, selected)
    const picked = listed.find(l => l.id === pickedId) ?? listed[listed.length - 1]
    const body = picked ? wrap(picked.text, width - 4) : []
    // Fixed heights: picking a message never moves the list or the Message rule. The reader
    // keeps a quarter of the pane; the list has the rest and starts at its top.
    const fixed = 1 + sessionRows + gap + 1 + gap + 1 + 2 // title, Sessions, gap, Messages rule, gap, Message rule, box border
    const shared = Math.max(4, height - fixed)
    const readerRoom = Math.min(shared - 2, clamp(Math.floor(height * 0.25), 3, 14))
    const logRows = Math.max(2, shared - readerRoom)

    // ── MESSAGES: newest at the bottom, one line each
    // A date row opens each day; the window's top row always names its day.
    const rows = withDays(listed)
    geometry.maxBack = Math.max(0, rows.length - logRows)
    const back = clamp(await read($, logBack), 0, geometry.maxBack)
    const visible = rows.slice(Math.max(0, rows.length - logRows - back), rows.length - back)
    const top = visible[0]
    if (top && 'line' in top) visible[0] = { day: dayLabel(top.line.ts) }
    geometry.readerTop = 1 + sessionRows + gap + 1 + logRows + gap

    // ── MESSAGE
    const isLong = body.length > readerRoom
    const window = isLong ? Math.max(1, readerRoom - 1) : readerRoom
    geometry.maxReader = Math.max(0, body.length - window)
    const rOffset = clamp(await read($, readerOffset), 0, geometry.maxReader)
    const shown = body.slice(rOffset, rOffset + window)
    const below = body.length - rOffset - shown.length
    // time 6 · from 12 · arrow 1 · to 12 · four gaps
    const textWidth = Math.max(10, width - 35)
    const drawn = visible.map((r): DrawnRow => {
                if ('day' in r) return { id: null, isPicked: false, cells: [{ text: `  ${r.day} `.padEnd(width, '·'), color: null }] }
                const l = r.line
                const isPicked = picked?.id === l.id
                return {
      id: l.id,
      isPicked,
      cells: [
        { text: `${isPicked ? '▸' : ' '}${hhmm(l.ts)} `, color: isPicked ? HUB : 'gray' },
        { text: `${clip(label(l.from), 12).padStart(12)} `, color: colorOf(l.from) },
        { text: '→ ', color: 'gray' },
        { text: `${clip(label(l.to), 12).padEnd(12)} `, color: colorOf(l.to) },
        { text: clip(oneLine(l.text.replace(/\*\*|`/g, '')), textWidth).padEnd(textWidth), color: null },
      ],
                }
    })
    // Drawn by log.tsx where the surface has Client; plain buttons elsewhere (vscode, mobile).
    let list
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const table = $.ui.resolve(e)
      list = table.Client({ key: 'log', module: './log.tsx', width, props: { rows: drawn } })
    } else {
      list = drawn.map((r, i) =>
        r.id ? (
          <Button key={`r-${r.id}`} plain onPress={() => update($, selected, () => r.id ?? '')}>
            {r.cells.map(c => c.text).join('')}
          </Button>
        ) : (
          <Text key={`d${i}`} dimColor>{r.cells[0]?.text ?? ''}</Text>
        ),
      )
    }

    const messageTitle = (
      header(
          'Message',
          picked ? `${hhmm(picked.ts)} ${label(picked.from)} → ${label(picked.to)}${pickedId === '' ? ' · newest' : ''}` : '',
          picked ? (
            <Box flexDirection="row" gap={2}>
              <Button key="copy" onPress={p => void $.ui.copy({ text: picked.text, surface: p.surface })}>copy</Button>
              {pickedId !== '' && <Button key="newest" onPress={() => update($, selected, () => '')}>newest</Button>}
            </Box>
          ) : undefined,
        )
    )

    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        <Box flexDirection="row" justifyContent="space-between" height={1}>
          <Text bold color={HUB}>◆ ORCHESTRA</Text>
          <Text dimColor>{watching && !watching.isOwn ? `watching ${self}` : 'this chat'}</Text>
        </Box>
        {sessionsSection}
        {spacer('gap1')}
        {header(
          'Messages',
          `${only ? `${listed.length} with ${label(only)}` : lines.length}${isReading ? ' · reading earlier…' : ''}`,
          <Box flexDirection="row" gap={3}>
            {toggle}
            {only ? (
              <Button key="all" onPress={() => pick(only)}>all</Button>
            ) : back > 0 ? (
              <Button key="follow" onPress={() => update($, logBack, () => 0)}>{`↓ ${back} newer`}</Button>
            ) : (
              <Text dimColor>wheel to scroll · click to read</Text>
            )}
          </Box>,
        )}
        <Box flexDirection="column" height={logRows} overflow="hidden">
          {listed.length === 0 && <Text dimColor>{isReading ? 'Reading…' : 'Quiet so far.'}</Text>}
          {list}
        </Box>
        {spacer('gap2')}
        {messageTitle}
        <Box borderStyle="round" borderColor={picked ? colorOf(picked.from) : 'gray'} flexDirection="column" paddingX={1} height={readerRoom + 2}>
          {!picked && <Text dimColor>Click a message to read it in full.</Text>}
          {shown.map((s, i) => (
            <Box key={`b${i}`} flexDirection="row">
              {s ? (
                inline(s).map((seg, j) => (
                  <Text key={`s${j}`} bold={seg.isBold} color={seg.isCode ? 'cyan' : undefined}>{seg.text}</Text>
                ))
              ) : (
                <Text> </Text>
              )}
            </Box>
          ))}
          {isLong && <Text dimColor>{below > 0 ? `↓ ${below} more lines · scroll here` : '↑ scroll up for the start'}</Text>}
        </Box>
      </Box>
    )
  })
}
