import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { ResearchTask } from './contracts.js';
import { advance, type FlowState, type SessionPorts } from './session.js';

const statuses = z.object({
  steps: z.number().int().nonnegative(),
  flow: z.custom<FlowState>(),
  failed: z.boolean().optional(),
});

export async function runResearchWorkflow(task: ResearchTask, ports: SessionPorts, signal: AbortSignal) {
  const id = task.job.mode === 'primary' ? `read-${task.job.branch.toLowerCase()}`
    : task.job.mode === 'lead' ? 'resolve-dispute' : `verify-${task.job.branch.toLowerCase()}`;
  let failure: { error: unknown } | undefined;
  const step = createStep({
    id: 'advance-durable-research',
    inputSchema: statuses,
    outputSchema: statuses,
    retries: 0,
    execute: async ({ inputData }) => {
      try {
        signal.throwIfAborted();
        return { steps: inputData.steps + 1, flow: await advance(task, ports) };
      } catch (error) {
        failure = { error };
        return { ...inputData, failed: true };
      }
    },
  });
  const workflow = createWorkflow({
    id: `facade-${id}`,
    inputSchema: statuses,
    outputSchema: statuses,
    retryConfig: { attempts: 0 },
    options: { shouldPersistSnapshot: () => false },
  }).dountil(step, async ({ inputData }) => inputData.failed === true || inputData.flow.status !== 'continue' || inputData.steps >= 12).commit();
  const run = await workflow.createRun({ disableScorers: true });
  const result = await run.start({ inputData: { steps: 0, flow: { status: 'continue' } } });
  if (failure) throw failure.error;
  if (result.status === 'success') return result.result.flow;
  if (result.status === 'failed') throw result.error;
  throw new Error(`Unexpected Mastra workflow state ${result.status}`);
}
