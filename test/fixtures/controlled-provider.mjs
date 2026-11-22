import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

export function createControlledProvider(script) {
  const queues = new Map(Object.entries(structuredClone(script)))
  const receipts = []

  return {
    async invoke({ branch, request, signal }) {
      signal?.throwIfAborted()
      const steps = queues.get(branch)
      if (!steps?.length) throw new Error(`No controlled response for branch ${branch}`)

      const requestSha256 = createHash('sha256').update(request).digest('hex')
      const { kind, delayMs = 0, output, code } = steps.shift()
      const receipt = {
        id: `fixture-${receipts.length + 1}`,
        provider: 'controlled',
        costUsd: 0,
        branch,
        requestSha256,
        outcome: 'pending',
      }
      receipts.push(receipt)

      try {
        await setTimeout(delayMs, undefined, { signal })
      } catch (error) {
        receipt.outcome = 'aborted'
        throw error
      }

      receipt.outcome = kind
      if (kind === 'reply') return { kind, output, receipt: { ...receipt } }
      if (kind === 'reject') return { kind, code, receipt: { ...receipt } }
      if (kind === 'disconnect') {
        throw Object.assign(new Error('Controlled disconnect'), { receipt: { ...receipt } })
      }
      throw new Error(`Unsupported controlled outcome: ${kind}`)
    },
    receipts: () => structuredClone(receipts),
  }
}
