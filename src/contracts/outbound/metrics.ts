/** Backend-neutral metric instruments; adapters map them onto a real backend. */
export type LabelValues<L extends string> = Partial<Record<L, string | number>>;

export interface CounterPort<L extends string = never> {
  inc(value?: number): void;
  inc(labels: LabelValues<L>, value?: number): void;
}

export interface GaugePort<L extends string = never> {
  set(value: number): void;
  set(labels: LabelValues<L>, value: number): void;
}

export interface HistogramPort<L extends string = never> {
  observe(value: number): void;
  observe(labels: LabelValues<L>, value: number): void;
}

export type NumberCollector = () => number | Promise<number>;
export type NumberMapCollector = () => Record<string, number> | Promise<Record<string, number>>;

export interface MetricsPort {
  sessionsActive: GaugePort;
  sessionsTotal: CounterPort<'reason'>;
  upstreamConnectionsActive: GaugePort<'upstream'>;
  upstreamConnectFailures: CounterPort<'upstream'>;
  upstreamConnectDuration: HistogramPort<'upstream'>;
  toolCallDuration: HistogramPort<'upstream' | 'tool'>;
  toolCallErrors: CounterPort<'upstream' | 'tool' | 'kind'>;
  refreshSuccess: CounterPort<'upstream'>;
  refreshFailures: CounterPort<'upstream'>;
  policyDecisions: CounterPort<'tool' | 'profile' | 'decision' | 'rule'>;
  approvalGrantUsed: CounterPort<'tool' | 'verb'>;
  approvals: CounterPort<'tool' | 'event'>;
  profileSelection: CounterPort<'source'>;
  auth: CounterPort<'result'>;
  tokenLifecycle: CounterPort<'event'>;
  secretRequests: CounterPort<'outcome'>;
  failclosedActive: GaugePort;
  tokensActive: GaugePort;
  consent: CounterPort<'level' | 'event'>;
  consentLatency: HistogramPort<'level'>;
  approvalsPending: GaugePort;
  shadowPSI: GaugePort<'feature'>;
  shadowTotal: CounterPort<'outcome'>;
  shadowLatency: HistogramPort;
  shadowDepth: GaugePort;
  shadowAgreement: CounterPort<'result'>;
  breakerTransitions: CounterPort<'scope' | 'to'>;
  breakerWouldTrip: CounterPort<'scope'>;
  breakerForced: CounterPort<'scope'>;
  breakerEscalations: CounterPort;
  breakerEvents: CounterPort<'event' | 'scope'>;
  breakerState: GaugePort<'scope'>;
  setShadowPSICollector(collector: NumberMapCollector): void;
  setPendingApprovalCollector(collector: NumberCollector): void;
  setActiveTokenCollector(collector: NumberCollector): void;
}

/** Text exposition of all metrics (e.g. Prometheus format) for the scrape endpoint. */
export interface MetricsExposition {
  exposition(): Promise<string>;
  readonly contentType: string;
}
