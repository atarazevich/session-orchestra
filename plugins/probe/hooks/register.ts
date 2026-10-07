import type { EngineInterface, Register } from 'claude-code'

// Probe for issue #2: what the mod API gives without $.process. Writes structure and counts only, never message text.
const OUT = '/Volumes/SSD/worktrees/session-orchestra-no-programs/probe-out'
let step: { model?: string; effort?: unknown } = {}
const live: { kind: string; ts: number; origin?: unknown; to?: string; envelope?: boolean; fromName?: string; len: number }[] = []

const fromName = (t: string) => /from-name="([^"]+)"/.exec(t)?.[1]

async function probe($: EngineInterface, args: string) {
  const id = await $.session.id()
  const out: Record<string, unknown> = { id, at: new Date().toISOString() }
  const t0 = Date.now()
  const msgs = await $.session.messages()
  out.messagesMs = Date.now() - t0
  out.count = msgs.length
  out.roles = msgs.reduce<Record<string, number>>((a, m) => ((a[m.role] = (a[m.role] ?? 0) + 1), a), {})
  out.keys = [...new Set(msgs.flatMap(m => Object.keys(m)))]
  out.peerEnvelopes = msgs.filter(m => m.role === 'user' && m.text.includes('<cross-session-message')).length
  out.peerFromNames = msgs.map(m => fromName(m.text)).filter(Boolean)
  out.firstIsSummary = msgs[0]?.text.startsWith('This session is being continued') ?? false
  out.firstTextHead = msgs[0]?.text.slice(0, 40)
  const uses = msgs.flatMap(m => m.toolUses)
  out.toolUses = uses.reduce<Record<string, number>>((a, u) => ((a[u.tool] = (a[u.tool] ?? 0) + 1), a), {})
  out.sendTo = uses.filter(u => u.tool === 'SendMessage').map(u => ({ to: u.input.to, inputKeys: Object.keys(u.input), resultKeys: u.result && typeof u.result === 'object' ? Object.keys(u.result) : typeof u.result }))
  // user rows that are plain prompts vs other
  // test sessions only: the probe panes' own text
  out.userRowsHead = msgs.filter(m => m.role === 'user' && m.text).map(m => m.text.slice(0, 60))
  out.userTextRows = msgs.filter(m => m.role === 'user' && m.text).length
  out.userToolResultRows = msgs.filter(m => m.role === 'user' && m.toolResults?.length).length
  // api form: are there timestamps anywhere?
  const api = await $.session.messages({ as: 'api' })
  out.apiCount = api.length
  out.apiBlockTypes = [...new Set(api.flatMap(m => (typeof m.content === 'string' ? ['string'] : m.content.map(b => b.type))))]
  out.apiHasTimestamp = JSON.stringify(api).includes('"timestamp"')
  out.apiPeerEnvelopes = api.filter(m => JSON.stringify(m.content).includes('cross-session-message')).length
  out.apiQueuedHint = api.filter(m => JSON.stringify(m.content).includes('queued')).length
  out.apiUserHead = api.filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('|')).slice(0, 80)).filter(Boolean)
  // own details without programs
  out.model = await $.session.model()
  out.step = step
  const usage = await $.session.usage()
  out.context = usage.context
  out.herdrPane = await $.env.get('HERDR_PANE_ID')
  out.agents = (await $.agent.list()).length
  out.live = live
  // fs limits
  const home = (await $.env.get('HOME')) ?? ''
  const big = args.trim()
  if (big) {
    const t1 = Date.now()
    out.bigRead = await $.fs.read(big).then(t => ({ ok: true, len: t.length }), (e: unknown) => ({ ok: false, err: String(e).slice(0, 200) }))
    out.bigReadMs = Date.now() - t1
  }
  const t2 = Date.now()
  const projects = await $.fs.list(`${home}/.claude/projects`)
  let found = 0
  for (const p of projects) if (p.kind === 'dir') found += (await $.fs.list(`${home}/.claude/projects/${p.name}`)).filter(f => f.name.endsWith('.jsonl')).length
  out.fsListProjects = { dirs: projects.length, jsonl: found, ms: Date.now() - t2 }
  // other sessions through the store
  await $.store.set(`probe:${id}`, { at: Date.now(), model: out.model })
  out.storeKeys = await $.store.keys()
  out.storeOthers = await Promise.all(out.storeKeys instanceof Array ? (out.storeKeys as string[]).map(async k => ({ k, v: await $.store.get(k) })) : [])
  // another session's agentId read
  const other = (await $.fs.list(`${home}/.claude/sessions`)).find(f => f.name.endsWith('.json'))
  if (other) {
    const reg = JSON.parse(await $.fs.read(`${home}/.claude/sessions/${other.name}`)) as { sessionId: string }
    out.otherAsAgent = await $.session.messages({ agentId: reg.sessionId }).then(r => (Array.isArray(r) ? { rows: r.length } : r), (e: unknown) => ({ err: String(e).slice(0, 200) }))
  }
  await $.fs.write(`${OUT}/${id}.json`, JSON.stringify(out, null, 1))
  return `probe written: ${OUT}/${id}.json`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'probe [big file]' })
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) step = { model: e.model, effort: e.effort }
    return yield* next(e)
  })
  on('session.receive', async ($, e, next) => {
    live.push({ kind: 'receive', ts: Date.now(), origin: e.origin, envelope: e.text.includes('<cross-session-message'), fromName: fromName(e.text), len: e.text.length })
    return next(e)
  })
  on('session.send', async ($, e, next) => {
    live.push({ kind: 'send', ts: Date.now(), origin: e.origin, to: e.to, len: e.text.length })
    return next(e)
  })
  on('command.run', { command: 'probe' }, async ($, e) => {
    try {
      return { text: await probe($, e.args) }
    } catch (err) {
      return { text: `probe failed: ${String(err)}` }
    }
  })
}
