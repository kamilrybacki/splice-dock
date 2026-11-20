import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export function createMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'splicedock' });
  collectDefaultMetrics({ register: registry });

  const sessionsActive = new Gauge({
    name: 'splicedock_sessions_active',
    help: 'Active SSE sessions',
    registers: [registry],
  });

  const sessionsTotal = new Counter({
    name: 'splicedock_sessions_total',
    help: 'Sessions by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const upstreamConnectionsActive = new Gauge({
    name: 'splicedock_upstream_connections_active',
    help: 'Active upstream connections',
    labelNames: ['upstream'] as const,
    registers: [registry],
  });

  const upstreamConnectFailures = new Counter({
    name: 'splicedock_upstream_connect_failures_total',
    help: 'Connect failures',
    labelNames: ['upstream'] as const,
    registers: [registry],
  });

  const upstreamConnectDuration = new Histogram({
    name: 'splicedock_upstream_connect_duration_seconds',
    help: 'Connect duration',
    labelNames: ['upstream'] as const,
    buckets: [0.01, 0.1, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const toolCallDuration = new Histogram({
    name: 'splicedock_tool_call_duration_seconds',
    help: 'Tool call duration',
    labelNames: ['upstream', 'tool'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
    registers: [registry],
  });

  const toolCallErrors = new Counter({
    name: 'splicedock_tool_call_errors_total',
    help: 'Tool call errors',
    labelNames: ['upstream', 'tool', 'kind'] as const,
    registers: [registry],
  });

  const refreshSuccess = new Counter({
    name: 'splicedock_refresh_success_total',
    help: 'Tool refresh successes',
    labelNames: ['upstream'] as const,
    registers: [registry],
  });

  const refreshFailures = new Counter({
    name: 'splicedock_refresh_failures_total',
    help: 'Tool refresh failures',
    labelNames: ['upstream'] as const,
    registers: [registry],
  });

  const policyDecisions = new Counter({
    name: 'splicedock_policy_decisions_total',
    help: 'CLI policy decisions by rule category',
    labelNames: ['tool', 'profile', 'decision', 'rule'] as const,
    registers: [registry],
  });

  const approvalGrantUsed = new Counter({name: 'splicedock_approval_grant_used_total', help: 'Standing grant uses', labelNames: ['tool','verb'] as const, registers: [registry]});
  const approvals = new Counter({
    name: 'splicedock_approvals_total',
    help: 'Approval lifecycle events',
    labelNames: ['tool', 'event'] as const,
    registers: [registry],
  });

  const profileSelection = new Counter({
    name: 'splicedock_profile_selection_total',
    help: 'MCP requests by how the profile was selected',
    labelNames: ['source'] as const,
    registers: [registry],
  });

  const auth = new Counter({ name: 'splicedock_auth_total', help: 'Authentication outcomes', labelNames: ['result'], registers: [registry] });
  const tokenLifecycle = new Counter({ name: 'splicedock_token_lifecycle_total', help: 'Token lifecycle events', labelNames: ['event'], registers: [registry] });
  const vaultRequests = new Counter({ name: 'splicedock_vault_requests_total', help: 'Secret resolution outcomes', labelNames: ['outcome'], registers: [registry] });
  const failclosedActive = new Gauge({ name: 'splicedock_failclosed_active', help: 'Last secret resolution failed closed', registers: [registry] });
  let countActiveTokens: () => number | Promise<number> = () => 0;
  const tokensActive = new Gauge({ name: 'splicedock_tokens_active', help: 'Active profile tokens', registers: [registry], async collect() { this.set(await countActiveTokens()); } });
  const consent = new Counter({name:'splicedock_consent_total',help:'Consent outcomes',labelNames:['level','event'],registers:[registry]});
  const consentLatency = new Histogram({name:'splicedock_consent_latency_seconds',help:'Consent latency',labelNames:['level'],buckets:[1,2,5,10,30,60,300,600],registers:[registry]});
  let pendingCount:()=>number|Promise<number>=()=>0;
  const approvalsPending = new Gauge({name:'splicedock_approvals_pending',help:'Pending approvals',registers:[registry],async collect(){this.set(await pendingCount());}});
  let shadowPSICollector:()=>Record<string,number>|Promise<Record<string,number>>=()=>({});
  const shadowPSI=new Gauge({name:'splicedock_shadow_feature_psi',help:'Feature PSI: previous retention window versus last day; absent until both have data',labelNames:['feature'],registers:[registry],async collect(){this.reset();try{for(const [feature,value] of Object.entries(await shadowPSICollector()))this.set({feature},value);}catch{/* observation only */}}});
  const shadowTotal=new Counter({name:'splicedock_shadow_total',help:'Shadow observations',labelNames:['outcome'],registers:[registry]});
  const shadowLatency=new Histogram({name:'splicedock_shadow_latency_seconds',help:'Shadow latency',registers:[registry]});
  const shadowDepth=new Gauge({name:'splicedock_shadow_queue_depth',help:'Shadow queue depth',registers:[registry]});
  const shadowAgreement=new Counter({name:'splicedock_shadow_agreement_total',help:'Shadow agreement',labelNames:['result'],registers:[registry]});
  const breakerTransitions=new Counter({name:'splicedock_breaker_transitions_total',help:'Breaker transitions',labelNames:['scope','to'],registers:[registry]});
  const breakerWouldTrip=new Counter({name:'splicedock_breaker_would_trip_total',help:'Observed trips',labelNames:['scope'],registers:[registry]});
  const breakerForced=new Counter({name:'splicedock_breaker_forced_approvals_total',help:'Forced approvals',labelNames:['scope'],registers:[registry]});
  const breakerEscalations=new Counter({name:'splicedock_breaker_escalations_total',help:'Forced approvals',registers:[registry]});
  const breakerEvents=new Counter({name:'splicedock_breaker_events_total',help:'Breaker events',labelNames:['event','scope'],registers:[registry]});
  const breakerState=new Gauge({name:'splicedock_breaker_state',help:'Breaker state',labelNames:['scope'],registers:[registry]});
  return {shadowPSI,setShadowPSICollector:(f:()=>Record<string,number>|Promise<Record<string,number>>)=>{shadowPSICollector=f;},shadowTotal,shadowLatency,shadowDepth,shadowAgreement,breakerTransitions,breakerWouldTrip,breakerForced,breakerEscalations,breakerEvents,breakerState,
    consent,consentLatency,approvalsPending,setPendingApprovalCollector:(f:()=>number|Promise<number>)=>{pendingCount=f;},
    setActiveTokenCollector: (collect: () => number | Promise<number>) => { countActiveTokens = collect; },
    auth, tokenLifecycle, vaultRequests, failclosedActive, tokensActive,
    registry,
    policyDecisions,
    approvals, approvalGrantUsed,
    profileSelection,
    sessionsActive,
    sessionsTotal,
    upstreamConnectionsActive,
    upstreamConnectFailures,
    upstreamConnectDuration,
    toolCallDuration,
    toolCallErrors,
    refreshSuccess,
    refreshFailures,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
