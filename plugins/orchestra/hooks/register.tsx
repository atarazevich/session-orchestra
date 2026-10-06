import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { BusLine, SessionView } from '../types'
import { demoData } from './demo'
import type { LogRow as DrawnRow } from './log'

const PANE = 'orchestra'
const POLL_MS = 15_000
const CHUNK_BYTES = 3_000_000 // under $.process.run's 4 MiB output cap
const KEEP = 1000
const MAX_SESSIONS = 24
const DEMO = 'demo'
const YOU = '@you'
const SELF = '@self'

const sessions = atom({ plugin: 'orchestra', key: 'sessions' } as const, [])
const bus = atom({ plugin: 'orchestra', key: 'bus' } as const, [])
const logBack = atom({ plugin: 'orchestra', key: 'logBack' } as const, 0)
const selected = atom({ plugin: 'orchestra', key: 'selected' } as const, '')
const readerOffset = atom({ plugin: 'orchestra', key: 'readerOffset' } as const, 0)
const page = atom({ plugin: 'orchestra', key: 'page' } as const, 0)
const filter = atom({ plugin: 'orchestra', key: 'filter' } as const, '')
const heard = atom({ plugin: 'orchestra', key: 'heard' } as const, { names: [], count: 0 })
const paneUp = atom({ plugin: 'orchestra', key: 'paneUp' } as const, false)
const selfName = atom({ plugin: 'orchestra', key: 'selfName' } as const, '')

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

const STATE: Record<SessionView['status'], { glyph: string; word: string; color: string }> = {
  working: { glyph: '◐', word: 'working', color: ACCENT },
  idle: { glyph: '○', word: 'idle', color: 'gray' },
  closed: { glyph: '✕', word: 'closed', color: 'gray' },
}

// One live session as Claude Code records it in ~/.claude/sessions/<pid>.json.
type Registered = { sessionId: string; cwd: string; name: string; status: string; messagingSocketPath?: string }
type Row = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  effort?: string
  attachment?: { type?: string; prompt?: string }
  message?: {
    model?: string
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    content?: string | { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const dayLabel = (ts: number) => {
  const d = new Date(ts)
  const label = `${d.toDateString().slice(0, 3)} ${d.getDate()} ${d.toDateString().slice(4, 7)}`
  return d.toDateString() === new Date().toDateString() ? `Today · ${label}` : label
}
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5
const modelName = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id)
  if (!m) return id
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
// Last drawn geometry, for the scroll hook to tell the log from the reader.
let geometry = { readerTop: Infinity, maxBack: 0, maxReader: 0 }
// Earlier transcripts are read once; the live one from where the last poll stopped.
let history: BusLine[] = []
let live = { offset: 0, lines: [] as BusLine[] }
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

// The same message from and to the same sessions within 2 minutes shows once.
function dedupe(lines: BusLine[]): BusLine[] {
  const last = new Map<string, number>()
  return lines.filter(l => {
    const key = `${l.from}|${l.to}|${oneLine(l.text).slice(0, 60)}`
    const twin = last.get(key)
    if (twin !== undefined && l.ts - twin < 120_000) return false
    last.set(key, l.ts)
    return true
  })
}

function parseBus(jsonl: string, nameOf: (address: string) => string): BusLine[] {
  const lines: BusLine[] = []
  const push = (ts: number, from: string, to: string, text: string) => {
    lines.push({ id: `${ts}|${from}|${to}|${hash(text)}`, ts, from, to, text: text.trim() })
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
      if (peer) push(ts, nameOf(peer[1] ?? '?'), SELF, peer[2] ?? '')
      else if ((queued !== undefined || !row.isMeta) && !/^\s*</.test(said) && !said.startsWith('This session is being continued'))
        push(ts, YOU, SELF, said)
    }

    if (row.type !== 'assistant' || content === undefined || typeof content === 'string') continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const input = block.input ?? {}
      if (block.name === 'SendMessage' && typeof input.to === 'string')
        push(ts, SELF, nameOf(input.to), String(input.message ?? ''))
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

// Reads a file from a byte offset to its last complete line, in chunks; answers the text and the new offset.
async function readFrom($: EngineInterface, file: string, offset: number) {
  let text = ''
  // Inside a line longer than a chunk: its rest, up to the next newline, is dropped.
  let skipping = false
  for (;;) {
    // The shell counts the bytes, never the decoded text: "<chunk bytes> <bytes to its last newline>", then those bytes.
    const chunk = `tail -c +${offset + 1} "$0" | head -c ${CHUNK_BYTES}`
    const out = await $.process.run(
      [
        'sh',
        '-c',
        `export LC_ALL=C; c=$(${chunk} | wc -c); k=$({ ${chunk}; printf x; } | tail -n 1 | wc -c); p=$((c - k + 1)); ` +
          `echo $((c)) $p; if [ $p -gt 0 ]; then ${chunk} | head -c $p; fi`,
        file,
      ],
      { timeoutMs: 20_000 },
    )
    const head = /^(\d+) (\d+)\n/.exec(out.stdout)
    if (out.exitCode !== 0 || !head) break
    const isFull = Number(head[1]) >= CHUNK_BYTES
    const upTo = Number(head[2])
    if (upTo === 0) {
      if (!isFull) break
      // a full chunk of one long line: step past its bytes
      offset += CHUNK_BYTES
      skipping = true
      continue
    }
    const whole = out.stdout.slice(head[0].length)
    text += skipping ? whole.slice(whole.indexOf('\n') + 1) : whole
    skipping = false
    offset += upTo
    if (!isFull) break
  }
  return { text, offset }
}

// A compacted session goes on in a new transcript; its summary names the one before.
async function chainOf($: EngineInterface, file: string, seen = new Set<string>()): Promise<string[]> {
  seen.add(file)
  const head = await $.process.run(['head', '-c', '400000', file])
  const before = /read the full transcript at: (\/[^\s"\\]+\.jsonl)/.exec(head.stdout)?.[1]
  if (!before || seen.has(before) || seen.size > 5) return [file]
  return [...(await chainOf($, before, seen)), file]
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
  const tail = await $.process.run(['tail', '-c', '300000', transcriptPath(root, s)], { timeoutMs: 5_000 })
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
  if (!w || w.sessionId === DEMO || polling === my) return
  polling = my
  try {
    const root = await home($)
    const found = await registry($)
    const nameOf = await namer($, found)

    const { text, offset } = await readFrom($, w.transcript, live.offset)
    if (my !== generation) return
    live = { offset, lines: [...live.lines, ...parseBus(text, nameOf)].slice(-KEEP) }
    const lines = dedupe([...history, ...live.lines]).slice(-KEEP)

    // The sessions this chat has talked to, the latest first.
    const lastTs = new Map<string, number>()
    for (const l of lines) for (const who of [l.from, l.to]) if (who !== YOU && who !== SELF && !isAgentId(who)) lastTs.set(who, l.ts)
    const names = [...lastTs.keys()].sort((a, b) => (lastTs.get(b) ?? 0) - (lastTs.get(a) ?? 0)).slice(0, MAX_SESSIONS)
    const views: SessionView[] = []
    for (const name of names) {
      const s = found.find(r => r.name === name && r.sessionId !== w.sessionId)
      const status: SessionView['status'] = !s ? 'closed' : s.status === 'busy' ? 'working' : 'idle'
      if (s && (status === 'working' || !details.has(s.sessionId))) details.set(s.sessionId, await detailOf($, root, s))
      const detail = (s && details.get(s.sessionId)) || { model: null, effort: null, ctx: null }
      views.push({ name, status, folder: s ? baseName(s.cwd) : null, ...detail })
    }
    if (my !== generation) return
    await update($, sessions, () => views)

    const before = await read($, bus)
    const only = await read($, filter)
    const back = await read($, logBack)
    if (my !== generation) return
    await update($, bus, () => lines)
    // A reader scrolled back keeps its place: the rows new messages add to the list, day rows too, push it down.
    const newest = before[before.length - 1]?.ts ?? 0
    const listed = lines.filter(l => !only || l.from === only || l.to === only)
    const added = withDays(listed).length - withDays(listed.filter(l => l.ts <= newest)).length
    if (my !== generation) return
    if (newest > 0 && added > 0 && back > 0) await update($, logBack, n => n + added)
  } catch {
    // the next poll tries again
  } finally {
    if (polling === my) polling = -1
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
  const lines = dedupe(parseBus(tail.stdout, a => a)).filter(l => l.from !== YOU)
  const names = [...new Set(lines.flatMap(l => [l.from, l.to]))].filter(n => n !== YOU && n !== SELF && !isAgentId(n) && !n.startsWith('herdr:'))
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
  const transcript = await transcriptOf($, sessionId)
  if (!transcript) return 'missing'
  const isOwn = sessionId === (await $.session.id())
  // Stop the old watch before the new one starts, so nothing reads the new transcript from the old offset.
  timer?.cancel()
  timer = null
  const my = ++generation
  history = []
  live = { offset: 0, lines: [] }
  watching = { transcript, sessionId, isOwn }
  const found = await registry($)
  const own = found.find(s => s.sessionId === sessionId)?.name
  const nameOf = await namer($, found)
  const earlier: BusLine[] = []
  for (const file of (await chainOf($, transcript)).slice(0, -1)) earlier.push(...parseBus((await readFrom($, file, 0)).text, nameOf))
  // switched again meanwhile: that switch owns the watch
  if (my !== generation) return 'superseded'
  history = earlier
  await update($, selfName, () => (!isOwn && own) || 'this chat')
  if (my !== generation) return 'superseded'
  timer = $.clock.every(POLL_MS, () => poll($))
  await poll($)
  return my === generation ? 'on' : 'superseded'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orchestra',
      description: 'Orchestrator view: on [session id] · off · (no argument) open the pane',
    })
    // In the background, so the full history read never holds up the first prompt.
    void (async () => {
      const own = await $.session.id()
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
    const count = off ? off.count : (await read($, bus)).length
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
      const demo = demoData(await $.clock.now())
      await update($, sessions, () => demo.sessions)
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
    // Surfaces without Client (vscode, mobile) get the list as plain buttons.
    const { Box, Button, Text, Client } = $.ui.resolve(e) as Elements[typeof e.surface] & Partial<Pick<Elements['terminal'], 'Client'>>
    const width = Math.max(44, e.props.bodyColumns ?? 64)
    const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const views = await read($, sessions)
    const lines = await read($, bus)
    const self = await read($, selfName)
    const working = views.filter(v => v.status === 'working').length
    const label = (who: string) => (who === YOU ? 'you' : who === SELF ? self || 'this chat' : who)
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

    // ── SESSIONS: cards in pages, 2 wide; one row of chips when short of room
    const open = views.filter(v => v.status !== 'closed')
    const closed = views.filter(v => v.status === 'closed')
    const perPage = height >= 44 ? 6 : height >= 32 ? 4 : 0
    const pages = perPage ? Math.max(1, Math.ceil(open.length / perPage)) : 1
    const at = clamp(await read($, page), 0, pages - 1)
    const shownViews = perPage ? open.slice(at * perPage, at * perPage + perPage) : open
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
    const card = (v: SessionView) => {
      const state = STATE[v.status]
      const isClosed = v.status === 'closed'
      const pct = v.ctx ?? 0
      const barWidth = Math.max(4, inner - LABEL)
      const filled = isClosed || v.ctx === null ? 0 : Math.round((barWidth * pct) / 100)
      const mark = Math.round((barWidth * DUMB_ZONE) / 100)
      const empty = Array.from({ length: barWidth - filled }, (_, i) => (filled + i === mark ? '╎' : '┄')).join('')
      const effort = v.effort ? EFFORT[v.effort] : undefined
      const isDumb = !isClosed && v.ctx !== null && pct >= DUMB_ZONE
      return (
        <Box key={v.name} borderStyle="round" borderColor={v.name === only ? HUB : v.status === 'working' ? ACCENT : 'gray'} flexDirection="column" width={cardWidth} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1} height={1} overflow="hidden">
              <Button key={`s-${v.name}`} plain onPress={() => pick(v.name)}>
                {clip(`✻ ${v.name}`, Math.max(4, inner - state.word.length - 3))}
              </Button>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text color={state.color}>{state.glyph} {state.word}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Text color={isClosed || !v.model ? 'gray' : 'cyan'}>{v.model ?? '—'}</Text>
              {effort && !isClosed && <Text color={effort.color}>{effort.bars}</Text>}
            </Box>
            <Box flexShrink={1} marginLeft={1}>
              <Text dimColor wrap="truncate-end">{v.folder ? `📁 ${v.folder}` : ''}</Text>
            </Box>
          </Box>
          <Box flexDirection="row">
            <Text color={ctxColor(pct)}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{empty}</Text>
            <Box width={LABEL} justifyContent="flex-end">
              <Text color={isClosed || v.ctx === null ? 'gray' : ctxColor(pct)} bold={isDumb}>
                {isClosed || v.ctx === null ? '–' : isDumb ? `${pct}% dumb` : `${pct}%`}
              </Text>
            </Box>
          </Box>
        </Box>
      )
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

    const sessionRows = 1 + (open.length === 0 ? 1 : perPage ? Math.ceil(shownViews.length / 2) * 5 : 1)
    const countsText = `${open.length} open${working ? ` · ${working} working` : ''}`
    // the rule's fixed parts: "── " + "Sessions " + counts + " " + at least 3 dashes + "  " + "──", and the pager
    const pagerWidth = pages > 1 ? 4 + pages * 2 + 3 : 0
    let room = width - (3 + 9 + countsText.length + 1 + 3 + 2 + 2) - pagerWidth - 'no longer running:'.length - 1
    const fits: SessionView[] = []
    for (const v of closed) {
      const need = v.name.length + 2 + (fits.length < closed.length - 1 ? 4 : 0)
      if (need > room) break
      fits.push(v)
      room -= need
    }
    const ended =
      closed.length > 0 ? (
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text dimColor>no longer running:</Text>
          <Box flexDirection="row" gap={2}>
            {fits.map(v => (
              <Button key={`s-${v.name}`} plain dimColor={v.name !== only} onPress={() => pick(v.name)}>{v.name}</Button>
            ))}
            {closed.length > fits.length && <Text dimColor>{`+${closed.length - fits.length}`}</Text>}
          </Box>
        </Box>
      ) : undefined
    const sessionsRight = pager || ended ? <Box flexDirection="row" gap={3}>{ended}{pager}</Box> : undefined
    const sessionsSection = (
      <Box flexDirection="column" height={sessionRows}>
        {header('Sessions', countsText, sessionsRight)}
        {open.length === 0 ? (
          <Text dimColor>None open. A session shows here once this chat messages it or hears from it.</Text>
        ) : perPage ? (
          Array.from({ length: Math.ceil(shownViews.length / 2) }, (_, r) => (
            <Box key={`row${r}`} flexDirection="row">
              {shownViews.slice(r * 2, r * 2 + 2).map(card)}
            </Box>
          ))
        ) : (
          <Box flexDirection="row" gap={2} height={1} overflow="hidden">
            {open.map(v => (
              <Box key={v.name} flexDirection="row" gap={1}>
                <Text color={STATE[v.status].color}>{STATE[v.status].glyph} {v.name}</Text>
                <Text color={ctxColor(v.ctx ?? 0)}>{v.ctx === null ? '–' : `${v.ctx}%`}</Text>
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
          only ? `${listed.length} with ${only}` : `${lines.length}`,
          only ? (
            <Button key="all" onPress={() => pick(only)}>all</Button>
          ) : back > 0 ? (
            <Button key="follow" onPress={() => update($, logBack, () => 0)}>{`↓ ${back} newer`}</Button>
          ) : (
            <Text dimColor>wheel to scroll · click to read</Text>
          ),
        )}
        <Box flexDirection="column" height={logRows} overflow="hidden">
          {listed.length === 0 && <Text dimColor>Quiet so far.</Text>}
          {Client ? (
          <Client
            key="log"
            module="./log.tsx"
            width={width}
            props={{ rows: drawn }}
          />
          ) : (
            drawn.map((r, i) =>
              r.id ? (
                <Button key={`r-${r.id}`} plain onPress={() => update($, selected, () => r.id ?? '')}>
                  {r.cells.map(c => c.text).join('')}
                </Button>
              ) : (
                <Text key={`d${i}`} dimColor>{r.cells[0]?.text ?? ''}</Text>
              ),
            )
          )}
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
