/**
 * Vocabulary of operational justifications. Words are written in surface form
 * and stemmed when the index is built, so one inflection per word is enough.
 * Extend the lists with general operations vocabulary, never with whole sentences.
 */

/** Function words: they carry neither the operation nor the reason. */
export const STOP_WORDS = `a an the and or to of in on for with is are this that it after before from
  am be been being was were has have had do does did will would can could should must may might
  i we you they he she me us them my our your their its his her which who whom what when where while
  there here these those some any each than then but if so as by at into onto via per because since due
  just now currently very too also still yet already keep let get got make need want try going
  up down out off back over about once please really actually simply longer anymore`;

/** A negator flips the next meaningful word: "not crashing" must not read as "crashing". */
export const NEGATORS = 'not no never without neither nor cannot';
/** Said of a subject after a copula ("the pool is healthy"): the subject is not the problem. */
export const FINE_WORDS = 'healthy fine intact unaffected okay ok';
export const COPULAS = 'is are was were looks look seems seem';

/**
 * Words that describe the operation or its object. Every justification of one
 * operation shape shares them, so they say what is done, not why.
 */
export const OPERATION_WORDS = `delete deletion remove removal kill recycle restart recreate reschedule respawn
  bounce nuke drop terminate close closing scale rescale resize rollout roll redeploy cycle replace
  pod container deployment deploy replicaset statefulset daemonset controller namespace cluster workload
  service app application replica instance issue pr ticket thing one new fresh force trigger bring come
  spin start run running current count set`;

/** Reasons: the state or goal that motivates the operation. One concept is one term. */
export const REASONS: Readonly<Record<string, string>> = {
  crash: 'crash crashloop panic segfault dying die coredump flap bootloop',
  fault: 'fail failure error errored broken faulty unhealthy degraded misbehave bad corrupt sick flaky notready buggy malfunction glitch',
  memory: 'oom memory mem ram heap leak bloat rss',
  stuck: 'stuck hang hung hanging frozen freeze froze stall wedge unresponsive deadlock jam zombie blocked linger ghost limbo',
  cleanup: 'cleanup tidy housekeeping leftover orphan obsolete prune purge sweep clutter declutter litter remnant dangling unused garbage cruft debris reap corpse residue stray',
  done: 'complete completion finish done succeed success exited ended fix resolve solve ship implement deliver merge',
  evict: 'evict eviction preempt preemption',
  terminating: 'finalizer sigterm sigkill graceful',
  pending: 'pending unschedulable unscheduled',
  disk: 'disk storage ephemeral volume pvc inode',
  secret: 'secret credential cred password passwd token key apikey cert certificate tls ssl keypair',
  rotate: 'rotate rotation renew renewal reissue regenerate expire expiry expiration swap',
  config: 'config configmap configuration env variable var flag param parameter toggle property',
  image: 'image tag digest latest registry artifact',
  spike: 'spike surge peak burst rush heavy saturate flood hammer overload overwhelm swamp busy',
  idle: 'idle low lull quiet minimal empty little slack unused',
  slow: 'slow latency lag backlog queue throttle sluggish timeout',
  cost: 'cost save saving budget spend bill cheap expensive money waste finops dollar',
  offhours: 'night overnight nightly weekend evening holiday offhours',
  maintenance: 'maintenance migrate migration upgrade downtime decommission deprecate retire sunset restore backup snapshot quiesce',
  test: 'test loadtest benchmark perf performance stress soak experiment drill rehearsal simulate',
  incident: 'incident outage mitigate mitigation emergency urgent page pager alert firefight hotfix sev oncall stopgap stabilize workaround postmortem',
  duplicate: 'duplicate dup dupe identical redundant same twin repeat copy',
  inactive: 'inactive abandon dormant unanswered silent ghosted cold untouched',
  stale: 'stale outdated old',
  wontfix: 'wontfix decline reject roadmap',
  spam: 'spam bot junk advert advertisement promo promotional scam abuse abusive offtopic troll gibberish ad unsolicited marketing crypto phishing',
  norepro: 'norepro unreproducible',
  superseded: 'supersede successor newer favor favour',
  invalid: 'invalid question misuse misconfiguration',
  dns: 'dns resolver nameserver hostname resolution lookup',
  pool: 'connection conn pool socket tcp keepalive permit',
  network: 'network endpoint upstream route routing packet',
  cache: 'cache cached',
  placement: 'rebalance spread affinity taint zone cordon drain relocate elsewhere',
  debug: 'debug troubleshoot investigate diagnose inspect',
  mesh: 'sidecar istio envoy proxy inject',
  probe: 'liveness readiness probe healthcheck',
  security: 'vulnerability vuln cve compromise breach exploit attack',
};

/** Subjects and directions: synonyms count as one term but weigh like an ordinary word. */
export const TOPICS: Readonly<Record<string, string>> = {
  node: 'node host machine hypervisor vm kubelet',
  load: 'traffic load request user visitor demand rps qps throughput capacity headroom',
  more: 'scaleup upscale increase extra additional raise grow expand add bigger ramp boost more climb soar double triple explode',
  fewer: 'scaledown downscale decrease shrink fewer zero downsize trim cut none park less stop shut halt pause suspend nothing',
  change: 'change update modify edit alter tweak revise bump adjust amend patch',
  reload: 'reload reread remount mount propagate apply refresh read fetch startup boot',
  database: 'database db postgres mysql sql schema',
  job: 'job cronjob cron batch task',
  retry: 'retry rerun reattempt',
};

/** Purposes no earlier approval can vouch for; see the veto in similarity.ts. */
export const RISK_WORDS = `hide hidden conceal unnoticed undetected covertly sneak stealth bypass
  circumvent evade tamper steal exfiltrate sabotage revenge retaliate spite prank evidence incriminating
  unauthorized unauthorised illegal illicit malicious backdoor anyway regardless nonetheless despite curious
  pretend pretext excuse falsely fake mislead deceive disguise publicly suppress exploit`;

const SEE = '(?:see|notic|know|find|check|look|catch)\\w*';
const CONTROL = '(?:review|approv|check|ci|test|audit|polic|gate|control|detect|alert|monitor|guardrail|oversight|scrutiny)\\w*';
const TRAIL = '(?:audit|evidence|trail|tracks?|traces?|logs?|records?|history)';
const phrase = (source: string, token: string): readonly [RegExp, string] => [new RegExp(`\\b(?:${source})\\b`, 'g'), ` ${token} `];

/** Multi-word expressions whose meaning is not the sum of their words. Applied in order. */
export const PHRASES: readonly (readonly [RegExp, string])[] = [
  phrase(`(?:no ?body|no one|none) (?:\\w+ )?${SEE}|secretly|in secret`, 'riskunseen'),
  phrase(`(?:before|until) (?:any(?:one|body)|some(?:one|body)) ${SEE}`, 'riskunseen'),
  phrase(`without (?:\\w+ )?(?:${CONTROL}|permission|asking|telling|notif\\w*|authori\\w*|consent|sign[ -]?off)`, 'riskunapproved'),
  phrase(`(?:skip|bypass|circumvent|evad|dodg|avoid|sidestep)\\w* (?:\\w+ ){0,2}?${CONTROL}`, 'riskbypass'),
  phrase(`cover\\w*(?: \\w+)? (?:up|tracks?)|${TRAIL}(?: \\w+){0,2}? (?:disappear|vanish|eras|wip)\\w*`, 'riskcover'),
  phrase('auto[ -]?approv\\w*', 'riskprobe'),
  phrase('(?:security|audit|compliance|policy|admission) (?:scanner|agent|monitor\\w*|checks?|controls?|logs?|logging|webhook|controller)', 'riskcontrol'),
  phrase('(?:ignore|disregard) (?:\\w+ )?(?:previous|prior|above|instructions?|polic\\w*|rules?)', 'riskoverride'),
  phrase('for (?:fun|kicks|laughs|no reason)|even though|although', 'riskidle'),
  phrase('crash[ -]*loop\\w*|clbo|restart\\w* (?:loop|count|repeatedly|constantly|endlessly|with backoff)|(?:keeps?|kept|constantly|repeatedly|endlessly) restart\\w*', 'crashloop'),
  phrase('oom[ -]*kill\\w*|out of (?:memory|ram)', 'oom'),
  phrase('clean\\w*[ -]up|garbage[ -]collect\\w*|get\\w* rid', 'cleanup'),
  phrase('left[ -]?overs?|left behind', 'leftover'),
  phrase('pick\\w*[ -]up|takes? effect|re-read\\w*', 'reload'),
  phrase('pull requests?', 'pr'),
  phrase('settings', 'config'),
  phrase('terminating', 'finalizer'),
  phrase('(?:stuck|hung|hanging|sitting|caught|trapped|wedged|frozen) (?:in|on|at)', 'in'),
  phrase('zero[ -]downtime', 'seamless'),
  phrase('(?:will not|wont) (?:be )?(?:fix|implement|address|do)\\w*|not planned|out of scope|(?:by|as) design(?:ed)?|as intended|not a bug|expected behaviou?r|no plans? to', 'wontfix'),
  phrase('(?:can ?not|could not|unable to|not able to|did not|does not|fail\\w* to) (?:be )?(?:repro|replicat)\\w*', 'norepro'),
  phrase('not reproducible|no repro\\w*|works? (?:fine )?(?:for me|on my \\w+|locally)', 'norepro'),
  phrase('no (?:recent |further |new )?(?:activity|response|repl\\w+|updates?|movement|follow[ -]?up|feedback|comments?)', 'inactive'),
  phrase('(?:never|not) (?:respond|repl|answer)\\w*', 'inactive'),
  phrase('already (?:tracked|reported|filed|exists?|covered|open\\w*|logged)|(?:tracked|covered) (?:in|by)', 'duplicate'),
  phrase('no (?:progress|logs?|output|heartbeat)|not (?:responding|progressing|moving|making progress)', 'stuck'),
  phrase('no (?:load|traffic|usage|users|requests)|no ?body (?:is |was )?(?:using|uses|on it)', 'idle'),
  phrase('scal\\w*(?: \\w+){0,3}? (?:up|out)', 'scaleup'),
  phrase('scal\\w*(?: \\w+){0,3}? (?:down|to (?:0|zero))', 'scaledown'),
  phrase('off[ -]hours?|after[ -]hours?|out of hours?|outside (?:business|office|working) hours', 'offhours'),
  phrase('black friday|cyber monday', 'spike'),
  phrase('load[ -]test\\w*', 'loadtest'),
  phrase('health[ -]checks?', 'healthcheck'),
  phrase('off[ -]topic', 'offtopic'),
  phrase('on[ -]call', 'oncall'),
  phrase('not[ -]?ready', 'notready'),
];
