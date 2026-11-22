import type { Attempt, ModelTransport, ProviderOutcome, RoutePolicy } from '../gateway/types.js';

export function managedTransport(endpoint: string): ModelTransport & { kind: 'managed' } {
  const address = new URL(endpoint);
  if (address.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(address.hostname)
      || address.username || address.password || address.hash) {
    throw new Error('FACADE_HARNESS_MANAGED_URL must be a local HTTP replay endpoint');
  }
  return {
    kind: 'managed',
    async send(attempt: Attempt, route: RoutePolicy, request: unknown, signal: AbortSignal): Promise<ProviderOutcome> {
      const response = await fetch(address, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attempt, routeId: route.id, request }),
      });
      if (!response.ok) {
        return { receipt: { state: 'unknown', code: 'managed_response_unavailable' } };
      }
      const result = await response.json() as ProviderOutcome;
      return result;
    },
  };
}
