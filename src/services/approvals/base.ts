import { runSweepExclusive } from '../database/sweep/lock.js';
import { StandingGrants, type GrantException } from './grants/standing.js';
import { kubectlShape, kubectlBaseShape, baseShapeKey } from '../policy/shape/kubectl.js';
// Approval flow for policies with on_violation: approval.
//
// Responsibilities:
//   - Compute argv_hash (binds an approval to one exact tool + resolved cwd +
//     argv; the cwd is also stored and must match on consume)
//   - Insert pending_approvals rows
//   - Bind each row to the caller (profile + non-secret token id); reserve
//     atomically and only for that exact caller
//   - Two-phase consume: the hook RESERVES a row; the wrapper FINALIZES it once
//     the child has spawned (never refunded, whatever the exit code) or
//     RELEASES it after a confirmed pre-spawn failure. Unsettled reservations
//     expire after reservationTtlMs and are never returned to approved
//   - Refuse callers without an authenticated profile token (missing identity
//     or the shared legacy ?profile= identity): nothing is created or consumed
//   - Reuse an existing pending row on retry (matched by argv_hash) instead of
//     inserting a duplicate
//   - Periodic expiry sweep
//
// Operators find pending rows via the admin WebUI / API (/admin/approvals).
// New rows also fire onRequested, which the server wires to Web Push.
//
// The shape of the ApprovalHook function returned by makeHook() matches the
// interface expected by cli-policy.ts::evaluatePolicy().

import { setTimeout as delay } from 'node:timers/promises';
import { ConsentStore } from './consent/store.js';
import { createHash, randomUUID } from 'node:crypto';

import type { ApprovalRepository } from '../../contracts/outbound/repositories.js';
import { logger } from '../../common/logger.js';
import type { ApprovalVerdict, AsyncApprovalHook } from '../policy/cli/rules.js';
import { currentCaller, type CallerIdentity } from '../../common/request/context.js';
import { opDigest, canonicalizeArgv } from '../policy/operation.js';

export class ApprovalWaitLimitError extends Error {
  constructor() {
    super('too many concurrent waits for this token (max 2); retry later');
  }
}

export interface ApprovalServiceOptions {
  store: ApprovalRepository;
  grantsEnabled?: boolean;
  grantThreshold?: number;
  grantContextMinSim?: number;
  grantExceptions?: readonly GrantException[];
  onGrantUsed?: (tool:string,verb:string)=>void;
  strongTools?: readonly string[];
  consentEnabled?:boolean;
  consentOrigin?: string;
  linkTtlMs?:number;

  /** Approval TTL in milliseconds. Default 10 min. */
  ttlMs?: number;
  /** How long a reservation may stay unsettled before it expires. Default 5 min. */
  reservationTtlMs?: number;
  /** Background expiry sweep interval. Default 60s. 0 = disabled. */
  sweepIntervalMs?: number;
  /** Injected `Date.now`-equivalent for tests. */
  now?: () => number;
  /** Metrics hook: called once per approval lifecycle event. */
  onConsentEvent?:(level:"weak"|"strong",event:string,latency?:number)=>void;
  onEvent?: (tool: string, event: ApprovalEvent) => void;
  /** Called once when a new pending row is created. Must not throw or block. */
  onRequested?: (info: { id: string; tool: string; expires_at: number }) => void;
}

export type ApprovalEvent =
  | 'webauthn_required_refused'
  | 'grant_used'
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'consumed'
  | 'released'
  | 'binding_refused'
  | 'identity_refused'
  | 'expired';

export const MAX_WAITS_PER_TOKEN = 2;

export class ApprovalService {
  readonly grants: StandingGrants;
  private readonly activeWaits = new Map<string, number>();
  private readonly store: ApprovalRepository;
  private readonly options: ApprovalServiceOptions;
  private readonly consent: ConsentStore;
  private readonly ttlMs: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private readonly onEvent: ApprovalServiceOptions['onEvent'];
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: ApprovalServiceOptions) {
    this.options = opts;
    this.store = opts.store;
    this.consent = new ConsentStore(opts.store.consentDatabase());
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.reservationTtlMs = opts.reservationTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.grants = new StandingGrants(opts.store.consentDatabase(), opts.grantsEnabled ?? false, opts.grantThreshold ?? 2, opts.grantContextMinSim ?? 0.5, this.now, opts.grantExceptions);

    const sweepInterval = opts.sweepIntervalMs ?? 60_000;
    if (sweepInterval > 0) {
      this.sweepTimer = setInterval(() => {
        runSweepExclusive(this.consent.db, 'approvalExpiry', () => this.sweep()).catch(err => logger.warn('approval sweep failed', { err: String(err) }));
      }, sweepInterval);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Returns an evaluator hook bound to `tool` and `cwd`, the realpath of the
   *  directory the command will be spawned in. The approval is bound to the
   *  cwd and to the caller (profile + non-secret token id): `caller` if
   *  given, else the AsyncLocalStorage identity at call time. A missing or
   *  unauthenticated identity, or an empty cwd, is refused (fail closed). */
  makeHook(tool: string, cwd: string, caller?: CallerIdentity, requireStrong = false, approvalContext?: string): AsyncApprovalHook {
    return async ({ argv, rule, matched }) =>
      await this.store.consentDatabase().transaction(async () => await this.handle(tool, cwd, caller ?? currentCaller(), argv, rule, matched, requireStrong, approvalContext))();
  }

  private emit(tool: string, event: ApprovalEvent, count = 1): void {
    for (let i = 0; i < count; i++) this.onEvent?.(tool, event);
  }

  private async handle(
    tool: string,
    cwd: string,
    caller: CallerIdentity | undefined,
    argv: readonly string[],
    rule: 'approval_subcommands' | 'approval_subcommand_paths',
    matched: string,
    requireStrong = false,
    approvalContext?: string,
  ): Promise<ApprovalVerdict> {
    requireStrong = requireStrong || (this.options.strongTools ?? []).includes(tool);
    if (approvalContext !== undefined && (typeof approvalContext !== 'string' || approvalContext.length > 500)) throw new Error('approval_context must be at most 500 characters');
    const now = this.now();
    if (!caller?.authenticated) {
      // Fail closed: every tokenless ?profile= caller shares one identity, so
      // binding an approval to it would let any of them consume it. Nothing is
      // consumed and nothing is created.
      logger.warn('approval refused: authenticated profile token required', {
        tool,
        rule,
        reason: caller ? 'unauthenticated' : 'missing_identity',
      });
      this.emit(tool, 'identity_refused');
      return { approved: false, refused: 'approval_requires_profile_token' };
    }
    if (cwd.length === 0) {
      // The wrapper always resolves a cwd; an empty one is a wiring bug.
      throw new Error('approval hook requires a resolved cwd');
    }
    const { profile, tokenId } = caller;
    const argv_hash = argvHash(tool, cwd, argv);

    await this.expireAll(now);

    // 1. Atomically reserve an approval bound to exactly this caller. The
    //    wrapper finalizes it after spawn or releases it on pre-spawn failure.
    const reservedId = await this.store.reserveBoundApproval(tool, argv_hash, profile, tokenId, cwd, now, this.options.consentEnabled !== false, requireStrong);
    if (reservedId) {
      logger.info('approval reserved', { tool, id: reservedId, profile, rule });
      return { approved: true, id: reservedId };
    }

    // An approved row exists but is bound to someone else: refuse, consume nothing.
    const foreign = await this.store.findApprovedAnyBinding(tool, argv_hash, now);
    if (foreign) {
      logger.warn('approval binding_refused', { tool, profile, id: foreign });
      this.emit(tool, 'binding_refused');
      this.options.onConsentEvent?.((await this.consent.get(foreign))?.level??'weak','binding_refused');
    }

    const shape = this.grants.enabled && tool === 'kubectl' && !await this.grants.exception(tool,matched,requireStrong) ? kubectlShape(argv,matched,caller) : null;
    const candidate = shape && approvalContext ? await this.grants.match(shape,approvalContext) : undefined;
    // Lock the pending approval before claiming a grant, matching reject's
    // approval -> grant order. The locked read rechecks status after waiting;
    // claim then rechecks quota, revocation, suspension and expiry.
    const existing = await this.store.findPendingFor(tool, argv_hash, profile, tokenId, cwd, now, true);
    const grant = candidate && await this.grants.claim(candidate.id) ? candidate : undefined;
    if (!grant && existing && (!requireStrong || (await this.consent.get(existing.id))?.level === 'strong')) {
      return { approved: false, id: existing.id, expires_at: existing.expires_at, payload:await this.payload(existing.id) };
    }

    if(grant && existing)await this.store.consentDatabase().prepare("UPDATE pending_approvals SET status='rejected',rejected_reason='superseded_by_grant' WHERE id=? AND status='pending'").run(existing.id);
    if(existing && requireStrong)await this.store.consentDatabase().prepare("UPDATE pending_approvals SET status='rejected',rejected_reason='strong_required' WHERE id=? AND status='pending'").run(existing.id);
    // 3. Create a new pending row bound to the caller.
    const id = randomUUID();
    const expires_at = now + this.ttlMs;
    await this.store.insertApproval({
      id,
      tool,
      argv_hash,
      argv_json: JSON.stringify(argv),
      rule,
      matched,
      requested_at: now,
      expires_at,
      profile,
      token_id: tokenId,
      cwd,
    });
    const baseShape = tool === 'kubectl' ? kubectlBaseShape(argv,matched,caller) : null;
    await this.store.consentDatabase().prepare('UPDATE pending_approvals SET shape_key=?,base_shape_key=?,approval_context=? WHERE id=?').run(shape ? JSON.stringify(shape) : null,baseShape ? baseShapeKey(baseShape) : null,approvalContext ?? null,id);
    if(grant) {
      await this.store.consentDatabase().prepare("UPDATE pending_approvals SET status='approved',approved_at=?,approved_by=?,consent_method='grant',grant_id=? WHERE id=?").run(now,`grant:${grant.id}`,grant.id,id);
      const reserved=await this.store.reserveBoundApproval(tool,argv_hash,profile,tokenId,cwd,now,true,false);
      if(reserved!==id)throw new Error('grant reservation failed');
      this.emit(tool,'grant_used');this.options.onGrantUsed?.(tool,matched);
      return {approved:true,id};
    }
    if (requireStrong) {
      await this.consent.bind(id,this.options.linkTtlMs);
    }
    logger.info('approval pending' , { tool, id, profile, rule, expires_at });
    this.emit(tool, 'requested');
    try { this.options.onRequested?.({ id, tool, expires_at }); } catch (err) {
      logger.warn('approval onRequested hook failed', { tool, error: (err as Error).message });
    }

    return { approved: false, id, expires_at, payload:await this.payload(id) };
  }

  /** Poll without consuming, exposing no existence information across bindings. */
  async wait(id: string, timeout_s: number, caller: CallerIdentity | undefined, signal?: AbortSignal): Promise<'approved' | 'rejected' | 'expired' | 'pending' | 'consumed' | 'in_use'> {
    if (!Number.isFinite(timeout_s) || timeout_s < 0) throw new Error('invalid timeout_s');
    if (!caller?.authenticated) throw new Error('approval not found');
    const key = caller.tokenId;
    const count = this.activeWaits.get(key) ?? 0;
    if (count >= MAX_WAITS_PER_TOKEN) throw new ApprovalWaitLimitError();
    this.activeWaits.set(key, count + 1);
    try {
      const deadline = Date.now() + Math.min(timeout_s, 120) * 1000;
      for (;;) {
        signal?.throwIfAborted();
        const row = await this.consent.get(id);
        if (!row || row.profile !== caller.profile || row.token_id !== caller.tokenId) throw new Error('approval not found');
        const now = this.now();
        if (row.status === 'reserved') return row.reserved_at !== null && row.reserved_at <= now - this.reservationTtlMs ? 'expired' : 'in_use';
        if ((row.status === 'pending' || row.status === 'approved') && row.expires_at <= now) return 'expired';
        if (row.status === 'approved' || row.status === 'rejected' || row.status === 'expired' || row.status === 'consumed') return row.status;
        if (Date.now() >= deadline) return 'pending';
        await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
      }
    } finally {
      const remaining = this.activeWaits.get(key)! - 1;
      if (remaining) this.activeWaits.set(key, remaining);
      else this.activeWaits.delete(key);
    }
  }

  reconfigureStrongTools(tools:readonly string[]):void {this.options.strongTools=[...tools];}

  private async payload(id:string) {
    const r=(await this.consent.get(id))!;
    return {approval_id:r.id,op_hash:(r.op_digest ?? opDigest({tool:r.tool,argv:JSON.parse(r.argv_json),cwd:r.cwd,profile:r.profile,tokenId:r.token_id},Math.floor(r.expires_at/1000),r.level,r.id)).slice(0,16),canonical_argv:canonicalizeArgv(JSON.parse(r.argv_json)),cwd:r.cwd,level:r.level,expires_at:r.expires_at,retry_hint:'Retry the SAME argv and cwd with the same profile token after operator approval; an approved request stays executable until its own expires_at'};
  }

  /** reserved → consumed, once the child process has spawned. */
  async finalize(id: string): Promise<boolean> {
    const ok = await this.store.finalizeApproval(id, this.now());
    if (ok) {
      logger.info('approval consumed', { id });
      await this.emitFor(id, 'consumed');
    } else {
      logger.warn('approval finalize found no reservation', { id });
    }
    return ok;
  }

  /** reserved → approved, only after a confirmed pre-spawn failure. */
  async release(id: string): Promise<boolean> {
    const grant = await this.store.consentDatabase().prepare('SELECT grant_id FROM pending_approvals WHERE id=? AND grant_id IS NOT NULL').get(id);
    const ok = grant ? (await this.store.consentDatabase().prepare("UPDATE pending_approvals SET status='expired' WHERE id=? AND status='reserved'").run(id)).changes===1 : await this.store.releaseApproval(id);
    if (ok) {
      logger.info('approval released after pre-spawn failure', { id });
      await this.emitFor(id, 'released');
    }
    return ok;
  }

  async listGrants() {return await this.grants.list();}
  async executionResult(id:string,success:boolean):Promise<void> {
    await this.store.consentDatabase().transaction(async ()=>{
      const changed=(await this.store.consentDatabase().prepare("UPDATE pending_approvals SET execution_success=? WHERE id=? AND status='consumed' AND execution_success IS NULL").run(Number(success),id)).changes;
      if(!changed)return;
      await this.grants.result(id,success);
      if(success)await this.grants.promote(id);
    })();
  }

  async isStrong(id:string):Promise<boolean> { return (await this.consent.get(id))?.level==='strong'; }

  async approve(id: string, by: string | null): Promise<boolean> {
    if(await this.isStrong(id)){await this.emitFor(id,'webauthn_required_refused');this.options.onConsentEvent?.('strong','webauthn_required_refused');return false;}
    const ok = await this.store.approveApproval(id, by, this.now());
    if (ok) {await this.emitFor(id, 'approved');const r=(await this.consent.get(id))!;this.options.onConsentEvent?.(r.level,'approved',(this.now()-r.requested_at)/1000);}
    return ok;
  }

  async reject(id: string, by: string | null): Promise<boolean> {
    let ok: boolean;
    for (let attempt = 0; ; attempt++) {
      try {
        ok = await this.store.consentDatabase().transaction(async ()=>{
          const changed=await this.store.rejectApproval(id, by, this.now());
          if(changed)await this.grants.rejected(id);
          return changed;
        })();
        break;
      } catch (error) {
        const code = (error as {code?:string} | null)?.code;
        // Retry the whole transaction; exhausted or unrelated failures must
        // reach the operator, never masquerade as a discarded rejection.
        if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
        await delay(10 * (attempt + 1));
      }
    }
    if (ok) {await this.emitFor(id, 'rejected');this.options.onConsentEvent?.((await this.consent.get(id))!.level,'rejected');}
    return ok;
  }

  private async emitFor(id: string, event: ApprovalEvent): Promise<void> {
    const row = await this.store.getApproval(id);
    if (row) this.emit(row.tool, event);
  }

  async list(opts: { status?: string; limit?: number } = {}) {
    return await this.store.listApprovals(opts);
  }

  async get(id: string) {
    return await this.store.getApproval(id);
  }

  async sweep(): Promise<number> {
    return await this.expireAll(this.now());
  }

  /** Expire overdue pending/approved rows and stale reservations. */
  private async expireAll(now: number): Promise<number> {
    const expiring=await this.consent.db.prepare("SELECT level,count(*) AS n FROM pending_approvals WHERE status IN ('pending','approved') AND expires_at<=? GROUP BY level").all(now) as {level:'weak'|'strong';n:number}[];
    for(const r of expiring)for(let i=0;i<r.n;i++)this.options.onConsentEvent?.(r.level,'expired');
    const per = [
      ...await this.store.expireOverdueByTool(now),
      ...await this.store.expireStaleReservations(now - this.reservationTtlMs),
    ];
    for (const e of per) this.emit(e.tool, 'expired', e.count);
    return per.reduce((n, e) => n + e.count, 0);
  }
}

/** Binding hash, v2: SHA-256 of the JSON encoding of ['v2', tool, cwd, argv].
 *  JSON keeps field boundaries unambiguous; the version tag guarantees no v2
 *  hash equals a pre-cwd (v1) hash, so legacy rows can never match. */
export function argvHash(tool: string, cwd: string, argv: readonly string[]): string {
  const canonical = canonicalizeArgv(argv);
  return createHash('sha256').update(JSON.stringify(['v2', tool, cwd, canonical])).digest('hex');
}
