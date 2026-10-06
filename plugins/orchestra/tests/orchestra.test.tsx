import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SCROLL = { offset: 0, bodyRows: 48 }
const pane = (bodyRows = 48) =>
  ({
    component: 'Pane',
    requestId: 'orchestra',
    props: { title: 'orchestra', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows } } as never,
  }) as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: SCROLL, view: {} } as never,
} as const

const row = (o: object) => JSON.stringify(o)
const peer = (name: string, text: string) =>
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${name}">${text}</cross-session-message>`
const LONG = 'Line one of a long report.\n- first bullet that goes on and on\n- second bullet\n\nTL;DR: all good.'

// The watched session S1: a prompt, a herdr send, SendMessage by name and by address, replies.
const TRANSCRIPT = [
  row({ type: 'user', timestamp: '2026-10-04T12:20:00Z', message: { content: 'get me up to date' } }),
  row({
    type: 'assistant',
    timestamp: '2026-10-04T12:26:42Z',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'herdr agent prompt w5:p1 "resume #81"' } }] },
  }),
  row({
    type: 'assistant',
    timestamp: '2026-10-04T12:27:00Z',
    message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'uds:/tmp/cc-socks/2.sock', message: 'hello researcher' } }] },
  }),
  row({ type: 'user', timestamp: '2026-10-04T12:27:17Z', message: { content: peer('agent development', LONG) } }),
  row({ type: 'user', isMeta: true, timestamp: '2026-10-04T13:48:54Z', message: { content: peer('backend', 'getlupa.com has stopped sending') } }),
  row({
    type: 'attachment',
    timestamp: '2026-10-04T13:50:00Z',
    attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:z" from-name="gone helper">bye</cross-session-message>' },
  }),
  row({ type: 'attachment', timestamp: '2026-10-04T13:51:00Z', attachment: { type: 'queued_command', prompt: 'yes to both' } }),
].join('\n')
const OLD = row({ type: 'user', timestamp: '2026-10-03T09:00:00Z', message: { content: 'from before compaction' } })
// Lines the transcript before compaction ends with, for a test.
let OLD_TAIL = ''

// Claude Code's own records of the live sessions.
const REGISTRY: Record<string, object> = {
  '1.json': { sessionId: 'S1', cwd: '/Users/x/work', name: 'orchestrator', status: 'busy' },
  '2.json': { sessionId: 'B', cwd: '/Users/x/work/backend', name: 'backend', status: 'busy' },
  '3.json': { sessionId: 'A', cwd: '/Users/x/work/agent', name: 'agent development', status: 'idle' },
  '4.json': { sessionId: 'R', cwd: '/Users/x/lab', name: 'researcher', status: 'shell', messagingSocketPath: '/tmp/cc-socks/2.sock' },
}
const REPLY = (tokens: number, effort: string, model = 'claude-opus-5-5') =>
  row({ type: 'assistant', effort, message: { model, usage: { input_tokens: 2, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } })

let EXTRA = ''
// When set, reading session A's transcript waits on it.
let gate: (() => Promise<void>) | null = null
let opens = 0
const store = new Map<string, unknown>()

async function fakeHost($: Engine, on: On, args = 'on', registry = REGISTRY, isPlaced = true) {
  on('process.run', async (_$, e) => {
    const [cmd, a1, a2, a3] = e.argv.map(String)
    if (cmd === 'head' && a3 === '/p/A.jsonl') await gate?.()
    // the read script answers "<bytes> <bytes to the last newline>", then those bytes
    const text = !a2?.includes('tail -c +1 ') ? '' : a3 === '/p/OLD.jsonl' ? OLD + OLD_TAIL + '\n' : TRANSCRIPT + EXTRA + '\n'
    const bytes = new TextEncoder().encode(text).length
    const out =
      cmd === 'sh' ? `${bytes} ${bytes}\n${text}`
      : cmd === 'head' ? (a3 === '/p/S1.jsonl' ? 'read the full transcript at: /p/OLD.jsonl\n' : '')
      : cmd === 'find' ? `/p/${String(e.argv[5])}\n`
      : cmd === 'herdr' ? JSON.stringify({ result: { agents: [{ pane_id: 'w5:p1', terminal_title_stripped: '◐ backend' }] } })
      : cmd === 'tail' && a3?.endsWith('/B.jsonl') ? REPLY(470_000, 'high')
      : cmd === 'tail' && a3?.endsWith('/A.jsonl') ? REPLY(90_000, 'medium', 'claude-opus-5-4-20260101')
      : cmd === 'tail' && a3?.endsWith('/O1.jsonl') ? REPLY(90_000, 'low', 'claude-3-5-sonnet-20241022')
      : cmd === 'tail' && a3?.endsWith('/O2.jsonl') ? REPLY(50_000, 'low', 'claude-3-haiku-20240307')
      : a1 ?? ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as never
  })
  on('fs.list', async () => ({ value: Object.keys(registry).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }) as never)
  on('fs.read', async (_$, e) => ({ value: JSON.stringify(registry[e.path.split('/').pop() ?? '']) }) as never)
  on('session.id', async () => ({ value: 'S1' }) as never)
  on('env.get', async () => ({ value: '/Users/x' }) as never)
  on('store.set', async (_$, e) => (store.set(e.key, e.value), { value: undefined }) as never)
  on('store.delete', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.copy', async () => ({ value: { isCopied: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.open', async () => (opens++, { value: { isPlaced } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async (h$, e) => {
    const { Text } = h$.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return $.command.run({ command: 'orchestra', args, origin: { kind: 'composer' }, presentation: {} } as never)
}

test('/orchestra on watches the session and remembers it for this session', async ($, on) => {
  const said = await fakeHost($, on)
  expect(said.text).toContain('watching this chat')
  expect(store.get('on:S1')).toBe('S1')
})

test('the sessions are the ones this chat talked to, read from Claude Code itself', async ($, on) => {
  await fakeHost($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestra', surface, ...pane() })
    expect(await ui.find({ type: 'Text', text: 'Sessions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 open · 1 working' })).toBeDefined()
    // herdr pane w5:p1 → backend; the SendMessage address → researcher; a name nobody carries → closed
    expect(await ui.find({ type: 'Button', text: /✻ backend/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /✻ researcher/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /✻ gone helper/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'gone helper' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no longer running:' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /✻ orchestrator/ })).toBeUndefined()
    // backend: 470k of 1M, high effort, its folder
    expect(await ui.find({ type: 'Text', text: '47% dumb' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▂▄▆' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /📁 backend/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    // agent development: a dated 5.4 id is a 1M window, 90k is 9%
    expect(await ui.find({ type: 'Text', text: 'Opus 5.4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '9%' })).toBeDefined()
    await ui.unmount()
  }
})

test('old-style model ids get the 200k window', async ($, on) => {
  EXTRA = ['old sonnet', 'old haiku'].map((n, i) => '\n' + row({ type: 'user', timestamp: `2026-10-04T14:0${i}:00Z`, message: { content: peer(n, 'hi') } })).join('')
  const live: Record<string, object> = {
    ...REGISTRY,
    'o1.json': { sessionId: 'O1', cwd: '/Users/x/o', name: 'old sonnet', status: 'busy' },
    'o2.json': { sessionId: 'O2', cwd: '/Users/x/o', name: 'old haiku', status: 'busy' },
  }
  try {
    await fakeHost($, on, 'on', live)
    const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
    // claude-3-5-sonnet: 90k of 200k; claude-3-haiku: 50k of 200k
    expect(await ui.find({ type: 'Text', text: '45% dumb' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
    await ui.unmount()
  } finally {
    EXTRA = ''
  }
})

test('a switch made while an earlier one still reads leaves the earlier one nothing to store or open', async ($, on) => {
  let arrived = () => {}
  let release = () => {}
  const reached = new Promise<void>(r => (arrived = r))
  const held = new Promise<void>(r => (release = r))
  gate = () => (arrived(), held)
  try {
    await fakeHost($, on, 'off')
    store.clear()
    const run = (args: string) => $.command.run({ command: 'orchestra', args, origin: { kind: 'composer' }, presentation: {} } as never)
    const slow = run('on A')
    await reached
    expect((await run('on S1')).text).toContain('watching this chat')
    const opened = opens
    expect(opened > 0).toBe(true)
    release()
    expect((await slow).text).toContain('took over')
    expect(store.get('on:S1')).toBe('S1')
    expect(opens).toBe(opened)
  } finally {
    gate = null
  }
})

test('the messages read every kind of send, back past a compaction, with day rows', async ($, on) => {
  await fakeHost($, on)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
  expect(await ui.find({ type: 'Text', text: 'Messages' })).toBeDefined()
  // The list draws in its own module; each row is read back by clicking it open.
  const open = async (y: number) => {
    await ui.pointer({ type: 'down', x: 40, y, button: 'left', in: 'log' })
    await ui.pointer({ type: 'up', x: 40, y, button: 'left', in: 'log' })
  }
  const rows: [number, RegExp, RegExp][] = [
    [1, /you → this chat/, /from before compaction/],
    [4, /this chat → backend/, /resume #81/],
    [5, /this chat → researcher/, /hello researcher/],
    [7, /backend → this chat/, /getlupa.com has stopped/],
    [9, /you → this chat/, /yes to both/],
  ]
  for (const [y, head, text] of rows) {
    await open(y)
    expect(await ui.find({ type: 'Text', text: head })).toBeDefined()
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  // a date row opens nothing
  await open(0)
  expect(await ui.find({ type: 'Text', text: /yes to both/ })).toBeDefined()
  await ui.unmount()
})

test('a message the old transcript also holds shows once', async ($, on) => {
  // the same prompt 30 s before the live one, in the transcript before compaction
  OLD_TAIL = '\n' + row({ type: 'user', timestamp: '2026-10-04T12:19:30Z', message: { content: 'get me up to date' } })
  try {
    await fakeHost($, on)
    const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
    expect(await ui.find({ type: 'Text', text: /^8$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^9$/ })).toBeUndefined()
    await ui.unmount()
  } finally {
    OLD_TAIL = ''
  }
})

test('clicking a message opens it in full under MESSAGE', async ($, on) => {
  await fakeHost($, on)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
  // rows: Sat 3 Oct · before compaction · Sun 4 Oct · prompt · herdr · SendMessage · the long one
  await ui.pointer({ type: 'move', x: 40, y: 6, in: 'log' })
  await ui.pointer({ type: 'down', x: 40, y: 6, button: 'left', in: 'log' })
  await ui.pointer({ type: 'up', x: 40, y: 6, button: 'left', in: 'log' })
  expect(await ui.find({ type: 'Text', text: /\d\d:\d\d agent development → this chat/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /second bullet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /TL;DR: all good\./ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'newest' })).toBeDefined()
  await ui.unmount()
})

test('more sessions than fit go to pages of 6, and to chips when short of room', async ($, on) => {
  EXTRA = Array.from({ length: 6 }, (_, i) =>
    '\n' + row({ type: 'user', timestamp: `2026-10-04T14:0${i}:00Z`, message: { content: peer(`helper ${i + 1}`, `hi ${i + 1}`) } }),
  ).join('')
  const live: Record<string, object> = { ...REGISTRY }
  for (let i = 1; i <= 6; i++) live[`h${i}.json`] = { sessionId: `H${i}`, cwd: '/Users/x/h', name: `helper ${i}`, status: 'idle' }
  try {
  await fakeHost($, on, 'on', live)
  // 9 open sessions and 1 closed: page 1 shows the 6 latest, page 2 the rest
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane(48) })
  expect(await ui.find({ type: 'Text', text: '9 open · 1 working' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /✻ helper 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /✻ backend/ })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Button', text: /✻ backend/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /✻ helper 6/ })).toBeUndefined()
  await ui.press({ key: 'p0' })
  expect(await ui.find({ type: 'Button', text: /✻ helper 6/ })).toBeDefined()
  await ui.unmount()
  const small = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane(20) })
  expect(await small.find({ type: 'Text', text: /○ helper 1/ })).toBeDefined()
  await small.unmount()
  } finally {
    EXTRA = ''
  }
})

test('a session\'s name shows only its messages, and all brings back every one', async ($, on) => {
  await fakeHost($, on)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
  expect(await ui.find({ type: 'Text', text: '◆ ORCHESTRA' })).toBeDefined()
  await ui.press({ key: 's-backend' })
  expect(await ui.find({ type: 'Text', text: '2 with backend' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /getlupa.com has stopped/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /yes to both/ })).toBeUndefined()
  await ui.press({ key: 'all' })
  expect(await ui.find({ type: 'Text', text: /yes to both/ })).toBeDefined()
  await ui.press({ key: 's-gone helper' })
  expect(await ui.find({ type: 'Text', text: '1 with gone helper' })).toBeDefined()
  await ui.unmount()
})

test('/orchestra demo fills the pane with made-up sessions', async ($, on) => {
  on('clock.now', async () => ({ value: Date.parse('2026-10-06T12:00:00Z') }) as never)
  await fakeHost($, on)
  const said = await $.command.run({ command: 'orchestra', args: 'demo', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(said.text).toContain('made-up')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...pane() })
  expect(await ui.find({ type: 'Text', text: '4 open · 2 working' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /✻ frontend/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'spike-auth' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '46% dumb' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'live' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rate limits per customer/ })).toBeDefined()
  await ui.unmount()
})

const HINT = {
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never,
} as const

function drawHint(on: On) {
  on('ui.render', { component: 'PromptHint' }, async (h$, e) => {
    const { Text } = h$.ui.resolve(e)
    const tail = (e.props as { tail?: string }).tail
    return <Text>{tail ? `hint · ${tail}` : 'hint'}</Text>
  })
}

test('with the mode on and the pane closed, the hint line ends with a note that opens it', async ($, on) => {
  drawHint(on)
  on('ui.panes', async () => ({ value: [] }) as never)
  // the pane never placed, as after the person closed it
  await fakeHost($, on, 'on', REGISTRY, false)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...HINT })
  expect(await ui.find({ type: 'Text', text: '? for shortcuts ·' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '◆ 3 sessions ⇄ 8' })).toBeDefined()
  await ui.unmount()
})

test('with the pane up, the hint line is left alone', async ($, on) => {
  drawHint(on)
  on('ui.panes', async () => ({ value: [{ id: 'orchestra', title: 'orchestra', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  await fakeHost($, on)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...HINT })
  expect(await ui.find({ type: 'Text', text: 'hint' })).toBeDefined()
  await ui.unmount()
})

test('with the mode off, a message from another session shows a note that turns the mode on', async ($, on) => {
  drawHint(on)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  await fakeHost($, on, 'off')
  await $.prompt.submit({
    text: peer('reviewer', 'looks good'),
    wait: false,
    origin: { kind: 'peer' },
  } as never)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...HINT })
  expect(await ui.find({ type: 'Button', text: '◆ 1 session ⇄ 1' })).toBeDefined()
  // a click turns the mode on here and opens the pane; the note then gives the line back
  await ui.press({ key: 'orchestra-open' })
  expect(store.get('on:S1')).toBe('S1')
  expect(await ui.find({ type: 'Text', text: 'hint' })).toBeDefined()
  await ui.unmount()
})

test('/orchestra off draws nothing above the prompt', async ($, on) => {
  await fakeHost($, on)
  await $.command.run({ command: 'orchestra', args: 'off', origin: { kind: 'composer' }, presentation: {} } as never)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})
