import type { Provider, ProviderResponse, ProviderStreamChunk } from './Provider.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { logForDebugging } from '../../utils/debug.js';

export type RouterStrategy = 'latency' | 'cost' | 'balanced';

export interface ProviderState {
  provider: Provider;
  latency_ms: number;
  avg_latency_ms: number;
  healthy: boolean;
  request_count: number;
  error_count: number;
}

export class SmartRouter {
  private states: Map<string, ProviderState> = new Map();
  private strategy: RouterStrategy;
  private fallbackEnabled: boolean;
  private initialized = false;

  constructor(
    providers: Provider[],
    strategy: RouterStrategy = (process.env.ROUTER_STRATEGY as RouterStrategy) || 'balanced',
    fallbackEnabled: boolean = !isEnvTruthy(process.env.ROUTER_FALLBACK_DISABLED)
  ) {
    this.strategy = strategy;
    this.fallbackEnabled = fallbackEnabled;
    for (const p of providers) {
      this.states.set(p.name, {
        provider: p,
        latency_ms: 9999,
        avg_latency_ms: 9999,
        healthy: true,
        request_count: 0,
        error_count: 0,
      });
    }
  }

  async initialize(): Promise<void> {
    logForDebugging('SmartRouter: benchmarking providers...');
    const pings = Array.from(this.states.values()).map(state => this.pingProvider(state));
    await Promise.allSettled(pings);
    this.initialized = true;
    
    const available = Array.from(this.states.values()).filter(s => s.healthy);
    logForDebugging(`SmartRouter ready. Available providers: ${available.map(s => s.provider.name).join(', ')}`);
  }

  private async pingProvider(state: ProviderState): Promise<void> {
    if (!state.provider.ping_url) {
      state.healthy = false;
      return;
    }

    const start = performance.now();
    try {
      const resp = await fetch(state.provider.ping_url, { signal: AbortSignal.timeout(5000) });
      const elapsed = performance.now() - start;
      
      // Reachable status codes
      if (resp.status < 500) {
        state.healthy = true;
        state.latency_ms = elapsed;
        state.avg_latency_ms = elapsed;
      } else {
        state.healthy = false;
      }
    } catch (e) {
      state.healthy = false;
      logForDebugging(`SmartRouter: ${state.provider.name} unreachable - ${e}`);
    }
  }

  private calculateScore(state: ProviderState): number {
    if (!state.healthy) return Infinity;

    const latencyScore = state.avg_latency_ms / 1000; // normalized to seconds
    const costScore = state.provider.cost_per_1k_tokens * 100; // normalized scale
    const errorRate = state.request_count > 0 ? state.error_count / state.request_count : 0;
    const errorPenalty = errorRate * 500;

    if (this.strategy === 'latency') {
      return latencyScore + errorPenalty;
    } else if (this.strategy === 'cost') {
      return costScore + errorPenalty;
    } else {
      return (latencyScore * 0.5) + (costScore * 0.5) + errorPenalty;
    }
  }

  selectProvider(isLargeRequest: boolean = false): ProviderState | undefined {
    const available = Array.from(this.states.values()).filter(s => s.healthy);
    if (available.length === 0) return undefined;

    return available.reduce((best, current) => 
      this.calculateScore(current) < this.calculateScore(best) ? current : best
    );
  }

  async recordResult(providerName: string, success: boolean, durationMs: number): Promise<void> {
    const state = this.states.get(providerName);
    if (!state) return;

    state.request_count++;
    if (success) {
      const alpha = 0.3;
      state.avg_latency_ms = (alpha * durationMs) + (1 - alpha) * state.avg_latency_ms;
    } else {
      state.error_count++;
      const errorRate = state.error_count / state.request_count;
      if (state.request_count >= 3 && errorRate > 0.7) {
        state.healthy = false;
        // Simple recovery attempt after 60s
        setTimeout(() => this.pingProvider(state), 60000);
      }
    }
  }

  getStatus() {
    return Array.from(this.states.values()).map(s => ({
      name: s.provider.name,
      healthy: s.healthy,
      avg_latency: s.avg_latency_ms.toFixed(1),
      score: this.calculateScore(s).toFixed(3),
      requests: s.request_count,
      errors: s.error_count
    }));
  }
}
