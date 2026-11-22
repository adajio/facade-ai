import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createControlledProvider } from './controlled-provider.mjs'

test('controlled routes preserve independent branches and zero-cost outcomes', async () => {
  const provider = createControlledProvider({
    A: [{ kind: 'reply', output: { value: '2' } }, { kind: 'reject', code: 'temporary' }],
    B: [{ kind: 'disconnect', delayMs: 5 }, { kind: 'reply', output: { value: '3' } }],
  })

  const [reply, disconnected] = await Promise.allSettled([
    provider.invoke({ branch: 'A', request: 'A initial' }),
    provider.invoke({ branch: 'B', request: Buffer.from('B initial') }),
  ])
  assert.equal(reply.status, 'fulfilled')
  assert.equal(reply.value.output.value, '2')
  assert.equal(disconnected.status, 'rejected')
  assert.equal(disconnected.reason.receipt.outcome, 'disconnect')
  assert.equal((await provider.invoke({ branch: 'A', request: 'A next' })).code, 'temporary')
  assert.equal((await provider.invoke({ branch: 'B', request: 'B next' })).output.value, '3')

  const receipts = provider.receipts()
  assert.deepEqual(receipts.map((receipt) => receipt.branch), ['A', 'B', 'A', 'B'])
  assert.deepEqual(receipts.map((receipt) => receipt.costUsd), [0, 0, 0, 0])
  assert.ok(receipts.every((receipt) => receipt.provider === 'controlled'))
  assert.equal(new Set(receipts.map((receipt) => receipt.requestSha256)).size, 4)
})

test('cancelling a delayed response records the outcome without blocking the other branch', async () => {
  const provider = createControlledProvider({
    A: [{ kind: 'reply', output: 'late', delayMs: 60_000 }],
    B: [{ kind: 'reply', output: 'ok' }],
  })
  const controller = new AbortController()
  const delayed = provider.invoke({ branch: 'A', request: 'delay', signal: controller.signal })
  controller.abort()

  await assert.rejects(delayed, { name: 'AbortError' })
  assert.equal((await provider.invoke({ branch: 'B', request: 'continue' })).output, 'ok')
  assert.equal(provider.receipts()[0].outcome, 'aborted')
})
