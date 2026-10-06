import type { BusLine, SessionView } from '../types'

// Made-up sessions and messages for `/orchestra demo`: a planner directing four workers.
export function demoData(now: number): { sessions: SessionView[]; bus: BusLine[] } {
  const day = 86_400_000
  const at = (daysAgo: number, hh: number, mm: number) => {
    const d = new Date(now - daysAgo * day)
    d.setHours(hh, mm, 0, 0)
    return d.getTime()
  }
  const lines: [number, string, string, string][] = [
    [at(1, 16, 2), '@you', '@self', 'Plan the checkout redesign. Frontend, api, tests and docs each take their part.'],
    [at(1, 16, 5), '@self', 'frontend', 'New task: the one-page checkout. Address, shipping and payment on one screen, the order summary sticky on the right.'],
    [at(1, 16, 5), '@self', 'api', 'New task: one POST /checkout that takes the cart, the address and the payment token, and answers the order or a field-level error.'],
    [at(1, 16, 6), '@self', 'tests', 'Write the end-to-end path first: guest checkout with a saved card, and the declined-card case.'],
    [at(1, 17, 40), 'api', '@self', 'POST /checkout is in review. Field errors come back as `{ field, message }`, one per field.'],
    [at(1, 18, 12), 'frontend', '@self', 'The form is built against the new errors. One question: should the summary collapse on mobile? I recommend yes, under 640 px.'],
    [at(1, 18, 14), '@self', 'frontend', 'Yes, collapse it under 640 px, and keep the total visible in the collapsed bar.'],
    [at(0, 9, 3), 'tests', '@self', 'Both paths pass against the review branch. The declined card shows the error under the card field, as specified.'],
    [at(0, 9, 20), '@self', 'docs', 'New task: update the API reference for POST /checkout, with one example per error.'],
    [
      at(0, 10, 41),
      'api',
      '@self',
      'POST /checkout is **live**.\n\n- Field errors: `{ field, message }`, one per field.\n- Idempotent: a retry with the same `Idempotency-Key` returns the first order.\n- p95 is 180 ms on staging.\n\nNext I add rate limits per customer, unless you want them per IP.',
    ],
    [at(0, 10, 44), '@self', 'api', 'Per customer. Go ahead.'],
    [at(0, 11, 2), 'docs', '@self', 'The reference is updated, with examples for the three errors. Preview link is in the PR.'],
    [at(0, 11, 30), '@you', '@self', 'How far is checkout from shipping?'],
    [at(0, 11, 31), '@self', 'frontend', 'Where are you on the mobile summary? The user asks how far we are from shipping.'],
    [at(0, 11, 48), 'frontend', '@self', 'Mobile summary done and in review. After that, only the empty-cart state is left.'],
  ]
  const bus = lines.map(([ts, from, to, text]) => ({ id: `demo|${ts}|${to}`, ts, from, to, text }))
  const sessions: SessionView[] = [
    { name: 'frontend', status: 'working', folder: 'web', model: 'Opus 5.5', effort: 'high', ctx: 18 },
    { name: 'docs', status: 'idle', folder: 'site', model: 'Sonnet 5.5', effort: 'low', ctx: 12 },
    { name: 'api', status: 'idle', folder: 'api', model: 'Opus 5.5', effort: 'medium', ctx: 46 },
    { name: 'tests', status: 'working', folder: 'api', model: 'Sonnet 5.5', effort: 'medium', ctx: 31 },
    { name: 'spike-auth', status: 'closed', folder: null, model: null, effort: null, ctx: null },
  ]
  bus.unshift({ id: 'demo|spike', ts: at(2, 15, 0), from: 'spike-auth', to: '@self', text: 'The passkey spike works in Chrome and Safari. Notes are in the spike branch; closing this session.' })
  return { sessions, bus }
}
