import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BusLine, SessionView } from '../types'
import { demoData } from './demo'
import type { LogRow as DrawnRow } from './log'

const PANE = 'orchestra'
const POLL_MS = 15_000
const KEEP = 1000
const MAX_SESSIONS = 24
const DEMO = 'demo'
const YOU = '@you'
const SELF = '@self'

const sessions = atom({ plugin: 'session-orchestra', key: 'sessions' } as const, [])
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

const STATE: Record<SessionView['status'], { glyph: string; word: string; color: string }> = {
  working: { glyph: '◐', word: 'working', color: ACCENT },
  idle: { glyph: '○', word: 'idle', color: 'gray' },
  closed: { glyph: '✕', word: 'closed', color: 'gray' },
}

// One live session as Claude Code records it in ~/.claude/sessions/<pid>.json.
type Registered = { sessionId: string; cwd: string; name: string; status: string; messagingSocketPath?: string }
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
let watching: { sessionId: string; isOwn: boolean } | null = null
let timer: { cancel: () => void } | null = null
// Bumped on every switch; a poll started before it writes nothing.
let generation = 0
// The generation whose poll is running, so polls never overlap.
let polling = -1
// The generation of a poll skipped while another ran: the running one runs once more when it ends.
let again = -1
// Last drawn geometry, for the scroll hook to tell the log from the reader.
let geometry = { readerTop: Infinity, maxBack: 0, maxReader: 0 }

// No programs: every session that runs this plugin keeps its own journal, and an orchestrator reads
// the journals. ~/.claude/session-orchestra/<sessionId>.json holds the messages (raw addresses, named
// when read); <sessionId>.meta.json the session's herdr pane, model, effort and context, kept small
// so a poll can read every live session's. Each file has one writer: its own session.
type Journal = { lines: BusLine[] }
type Meta = { pane: string | null; model: string | null; effort: string | null; ctx: number | null; updatedAt: number }
const JOURNAL_BYTES = 3_500_000 // under $.fs's 4 MiB read and write limit
let journal: Journal | null = null
let meta: Meta = { pane: null, model: null, effort: null, ctx: null, updatedAt: 0 }
// Writes in order, one at a time.
let writing: Promise<unknown> = Promise.resolve()

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? '~'
}
const dirOf = async ($: EngineInterface) => `${await home($)}/.claude/session-orchestra`

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}
const readJournal = async ($: EngineInterface, id: string) => readJson<Journal>($, `${await dirOf($)}/${id}.json`)
const readMeta = async ($: EngineInterface, id: string) => readJson<Meta>($, `${await dirOf($)}/${id}.meta.json`)

async function saveJournal($: EngineInterface) {
  const j = journal
  if (!j) return
  let text = JSON.stringify(j)
  while (new TextEncoder().encode(text).length > JOURNAL_BYTES && j.lines.length > 1) {
    j.lines = j.lines.slice(Math.ceil(j.lines.length / 4))
    text = JSON.stringify(j)
  }
  const path = `${await dirOf($)}/${await $.session.id()}.json`
  writing = writing.then(() => $.fs.write(path, text)).catch(() => {})
  await writing
}
async function saveMeta($: EngineInterface) {
  meta = { ...meta, updatedAt: await $.clock.now() }
  const path = `${await dirOf($)}/${await $.session.id()}.meta.json`
  const text = JSON.stringify(meta)
  writing = writing.then(() => $.fs.write(path, text)).catch(() => {})
  await writing
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

// FNV-1a of the full text, so two messages that start alike keep apart ids.
const hash = (s: string) => {
  let x = 0x811c9dc5
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193)
  return (x >>> 0).toString(36)
}
const line = (ts: number, from: string, to: string, text: string): BusLine => ({ id: `${ts}|${from}|${to}|${hash(text)}`, ts, from, to, text: text.trim() })
const HERDR_PROMPT = /herdr agent prompt (w\d+:p\w+) "((?:[^"\\]|\\.)*)"/g
const ENVELOPE = /<cross-session-message[^>]*from-name="([^"]+)"[^>]*>([\s\S]*?)<\/cross-session-message>/g

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

// A first start with the plugin: what the session already holds. Rows carry no time, so the lines are
// stamped in order from the session's start; peers' messages are only in the API form, after the rest.
async function backfill($: EngineInterface): Promise<BusLine[]> {
  const rows = await $.session.messages()
  const api = await $.session.messages({ as: 'api' })
  let ts = (await $.session.usage()).startedAt
  const lines: BusLine[] = []
  for (const row of rows) {
    if (row.role === 'user' && row.text && !row.toolResults?.length && !/^\s*</.test(row.text) && !row.text.startsWith('This session is being continued'))
      lines.push(line(ts++, YOU, SELF, row.text))
    for (const use of row.toolUses) {
      if (use.tool === 'SendMessage' && typeof use.input.to === 'string') lines.push(line(ts++, SELF, use.input.to, String(use.input.message ?? '')))
      if (use.tool === 'Bash' && typeof use.input.command === 'string')
        for (const m of use.input.command.matchAll(HERDR_PROMPT)) lines.push(line(ts++, SELF, `herdr:${m[1] ?? ''}`, (m[2] ?? '').replace(/\\"/g, '"')))
    }
  }
  for (const m of api) {
    const text = typeof m.content === 'string' ? m.content : m.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
    if (m.role === 'user') for (const p of text.matchAll(ENVELOPE)) lines.push(line(ts++, p[1] ?? '?', SELF, p[2] ?? ''))
  }
  return lines.filter(l => l.text !== '/compact').slice(-KEEP)
}

// Opens this session's own journal, from its file or, the first time, from what the session holds.
async function openJournal($: EngineInterface) {
  journal = (await readJournal($, await $.session.id())) ?? { lines: await backfill($) }
  meta = { ...meta, pane: (await $.env.get('HERDR_PANE_ID')) ?? null }
  await saveJournal($)
  await saveMeta($)
}

// One message of this session, as it happens.
async function record($: EngineInterface, from: string, to: string, text: string) {
  if (!journal || text.trim() === '' || text.trim() === '/compact') return
  journal.lines = [...journal.lines, line(await $.clock.now(), from, to, text)].slice(-KEEP)
  await saveJournal($)
  if (from !== YOU) await hear($, from === SELF ? to : from)
  if (watching?.isOwn) void poll($)
}

// Names an address the way the live sessions call themselves: a socket through the registry, a herdr
// pane through the pane the session there wrote in its meta.
function namer(found: Registered[], panes: Record<string, string>) {
  return (address: string) => {
    if (address.startsWith('uds:')) return found.find(s => s.messagingSocketPath === address.slice(4))?.name ?? address
    if (address.startsWith('herdr:')) return panes[address.slice(6)] ?? address.slice(6)
    return address
  }
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
    const found = await registry($)
    const metas = new Map<string, Meta>()
    for (const s of found) {
      const m = await readMeta($, s.sessionId)
      if (m) metas.set(s.sessionId, m)
    }
    const panes: Record<string, string> = {}
    for (const s of found) {
      const pane = metas.get(s.sessionId)?.pane
      if (pane) panes[pane] = s.name
    }
    const nameOf = namer(found, panes)
    const watched = w.isOwn ? journal : await readJournal($, w.sessionId)
    if (my !== generation || !watched) return
    const lines = dedupe(watched.lines.map(l => ({ ...l, from: nameOf(l.from), to: nameOf(l.to) }))).slice(-KEEP)

    // The sessions this chat has talked to, the latest first.
    const lastTs = new Map<string, number>()
    for (const l of lines) for (const who of [l.from, l.to]) if (who !== YOU && who !== SELF && !isAgentId(who)) lastTs.set(who, l.ts)
    const names = [...lastTs.keys()].sort((a, b) => (lastTs.get(b) ?? 0) - (lastTs.get(a) ?? 0)).slice(0, MAX_SESSIONS)
    const views: SessionView[] = names.map(name => {
      const s = found.find(r => r.name === name && r.sessionId !== w.sessionId)
      const status: SessionView['status'] = !s ? 'closed' : s.status === 'busy' ? 'working' : 'idle'
      const m = s && metas.get(s.sessionId)
      return { name, status, folder: s ? baseName(s.cwd) : null, model: m?.model ? modelName(m.model) : null, effort: m?.effort ?? null, ctx: m?.ctx ?? null }
    })
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
    if (await read($, reading)) await update($, reading, () => false)
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

// On start with the mode off: what this session's journal already holds.
async function scanOwn($: EngineInterface) {
  const lines = dedupe(journal?.lines ?? []).filter(l => l.from !== YOU)
  const names = [...new Set(lines.flatMap(l => [l.from, l.to]))].filter(n => n !== YOU && n !== SELF && !isAgentId(n) && !n.startsWith('herdr:'))
  await update($, heard, () => ({ names, count: lines.length }))
}

// Opens the pane and records whether it is up: the plugin's own calls do not pass its own hooks.
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'orchestra' })
  await update($, paneUp, () => opened.isPlaced)
  return opened
}

// 'missing': another session that keeps no journal (it does not run this plugin).
// 'superseded': a later switch, demo or off took over meanwhile, and the caller does nothing.
async function turnOn($: EngineInterface, sessionId: string): Promise<'on' | 'missing' | 'superseded'> {
  const entry = generation
  const isOwn = sessionId === (await $.session.id())
  const exists = isOwn || (await $.fs.exists(`${await dirOf($)}/${sessionId}.json`))
  if (entry !== generation) return 'superseded'
  if (!exists) return 'missing'
  timer?.cancel()
  timer = null
  const my = ++generation
  watching = { sessionId, isOwn }
  try {
    await update($, reading, () => true)
    const own = (await registry($)).find(s => s.sessionId === sessionId)?.name
    await update($, selfName, () => (!isOwn && own) || 'this chat')
    if (my !== generation) return 'superseded'
    timer = $.clock.every(POLL_MS, () => poll($))
    await poll($)
    return my !== generation ? 'superseded' : 'on'
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orchestra',
      description: 'Orchestrator view: on [session id] · off · (no argument) open the pane',
    }).catch(() => {
      // the session starts all the same
    })
    void (async () => {
      await openJournal($)
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

  // The journal: every message of this session as it happens, from the engine's own events.
  on('session.send', async ($, e, next) => {
    if (e.agentId === undefined) await record($, SELF, e.to, e.text).catch(() => {})
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'peer')
      for (const m of e.text.matchAll(ENVELOPE)) await record($, m[1] ?? '?', SELF, m[2] ?? '').catch(() => {})
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.text.startsWith('/'))
      await record($, YOU, SELF, e.text).catch(() => {})
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined)
      for (const m of e.command.matchAll(HERDR_PROMPT))
        await record($, SELF, `herdr:${m[1] ?? ''}`, (m[2] ?? '').replace(/\\"/g, '"')).catch(() => {})
    return next(e)
  })
  // This session's model and effort as each request goes out, its context once the turn ends.
  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? null : String(e.effort)
    if (e.agentId === undefined && (meta.model !== e.model || meta.effort !== effort)) {
      meta = { ...meta, model: e.model, effort }
      await saveMeta($).catch(() => {})
    }
    return yield* next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      meta = { ...meta, ctx: (await $.session.usage()).context.percent ?? null }
      await saveMeta($).catch(() => {})
    }
    return result
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
      watching = { sessionId: DEMO, isOwn: true }
      await update($, reading, () => false)
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
      if (state === 'missing') return { text: `Session ${target} keeps no orchestra journal: it does not run this plugin.` }
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
    const lines = await read($, bus)
    const self = await read($, selfName)
    const isReading = await read($, reading)
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
          <Text dimColor>{isReading ? 'Reading the journal…' : 'None open. A session shows here once this chat messages it or hears from it.'}</Text>
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
          `${only ? `${listed.length} with ${only}` : lines.length}${isReading ? ' · reading earlier…' : ''}`,
          only ? (
            <Button key="all" onPress={() => pick(only)}>all</Button>
          ) : back > 0 ? (
            <Button key="follow" onPress={() => update($, logBack, () => 0)}>{`↓ ${back} newer`}</Button>
          ) : (
            <Text dimColor>wheel to scroll · click to read</Text>
          ),
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
