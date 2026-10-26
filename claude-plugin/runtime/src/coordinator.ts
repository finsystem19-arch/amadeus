import { DatabaseSync } from "node:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_USAGE_LIMIT_WAIT_MS, detectUsageLimit, type UsageLimit } from "./provider-limits.ts";
import { estimateCreditMicros, lunaRateCard, validateUsage, type CodexUsage } from "./usage-accounting.ts";
import { formatGoalIterationObjective, withRecordedOwnerAuthorization, type GoalDecision } from "./goal-protocol.ts";
import { hasExplicitAttemptRestriction } from "./technical-recovery.ts";
import {
  resolveMilestoneGitAuthorization,
  type GoalGitApproval,
  type MilestoneGitAction,
  type MilestoneGitDecision,
} from "./milestone-git-authorization.ts";
import { migrateCoordinatorSchema } from "./coordinator-schema.ts";
import {
  defaultDatabasePath, parseNonnegativeInteger, projectRootsOverlap, terminalStatuses,
  type GoalStatus, type JobStatus, type ProgressGuard, type ProgressLimits,
} from "./coordinator-types.ts";

export { normalizeProjectRoot, projectRootsOverlap, type ProgressGuard, type ProgressLimits } from "./coordinator-types.ts";

export class Coordinator {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(path = defaultDatabasePath(), options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Configure the busy timeout before the lock-sensitive journal-mode
    // statement. A background worker can briefly retain SQLite's write lock
    // while it finishes cleanup, especially on Windows CI.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    migrateCoordinatorSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private setting(key: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) throw new Error(`Missing setting: ${key}`);
    return row.value;
  }

  private event(jobId: string | null, kind: string, detail: unknown): void {
    this.db.prepare("INSERT INTO events(job_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(jobId, kind, JSON.stringify(detail), this.now());
  }

  private goalEvent(goalId: string, kind: string, detail: unknown): void {
    this.db.prepare("INSERT INTO goal_events(goal_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(goalId, kind, JSON.stringify(detail), this.now());
  }

  progressLimits(): ProgressLimits {
    return {
      consecutiveFailures: Number(this.setting("progress_failure_limit")),
      consecutiveWithoutChange: Number(this.setting("progress_idle_limit")),
      aiCallsPer24h: Number(this.setting("daily_ai_call_limit")),
    };
  }

  configureProgressLimits(input: Partial<ProgressLimits>): ProgressLimits {
    const entries = [
      ["progress_failure_limit", input.consecutiveFailures],
      ["progress_idle_limit", input.consecutiveWithoutChange],
      ["daily_ai_call_limit", input.aiCallsPer24h],
    ] as const;
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
      this.db.prepare("UPDATE settings SET value=? WHERE key=?").run(String(value), key);
    }
    const limits = this.progressLimits();
    this.event(null, "progress_limits_changed", limits);
    return limits;
  }

  /**
   * Progress guard for unattended runs. Automatic continuation stops and asks
   * the owner once a goal shows repeated failure, a long run of iterations with
   * no applied change, or too many AI-worker calls in 24 hours. Tokens are
   * reported elsewhere and are deliberately not a limit. Only an owner answer
   * (answer_goal) or an explicit reset starts a fresh window.
   */
  progressGuard(goalId: string): ProgressGuard {
    const limits = this.progressLimits();
    const events = this.goalEvents(goalId);
    const windowStart = events.filter((event) => event.kind === "answered" || event.kind === "progress_limit_reset")
      .at(-1)?.created_at as string | undefined;
    const decisions = new Map<string, string>();
    for (const event of events) {
      if (event.kind !== "iteration_completed" && event.kind !== "iteration_recovered") continue;
      try {
        const detail = JSON.parse(String(event.detail)) as { jobId?: string; decision?: { status?: string } };
        if (detail.jobId) decisions.set(detail.jobId, String(detail.decision?.status ?? ""));
      } catch { /* malformed history is ignored rather than counted */ }
    }
    const jobs = this.db.prepare(`
      SELECT j.id, j.status, j.outcome, (SELECT MAX(applied) FROM patch_receipts p WHERE p.job_id=j.id) AS applied
      FROM jobs j WHERE j.goal_id=? AND j.status IN ('completed', 'failed', 'uncertain') AND j.created_at >= ?
      ORDER BY j.goal_iteration DESC
    `).all(goalId, windowStart ?? "") as { id: string; status: string; outcome: string | null; applied: number | null }[];
    const counted = jobs.filter((job) => !(job.status === "failed" && detectUsageLimit(String(job.outcome ?? ""))));
    const failed = (job: typeof jobs[number]) => job.status !== "completed" || decisions.get(job.id) === "blocked";
    const progressed = (job: typeof jobs[number]) => Number(job.applied) === 1 || decisions.get(job.id) === "complete";
    const streak = (test: (job: typeof jobs[number]) => boolean) => {
      let count = 0;
      for (const job of counted) { if (!test(job)) break; count += 1; }
      return count;
    };
    const consecutiveFailures = streak(failed);
    const consecutiveWithoutChange = streak((job) => !progressed(job));
    const since = new Date(this.clock().getTime() - 24 * 60 * 60 * 1000).toISOString();
    const routes = this.db.prepare(`
      SELECT e.detail FROM events e JOIN jobs j ON j.id=e.job_id
      WHERE j.goal_id=? AND e.kind='route_selected' AND e.created_at >= ?
    `).all(goalId, windowStart && windowStart > since ? windowStart : since) as { detail: string }[];
    const aiCallsLast24h = routes.filter((row) => {
      try { return JSON.parse(JSON.parse(row.detail).detail).provider !== "software"; }
      catch { return true; }
    }).length;
    const reason = consecutiveFailures >= limits.consecutiveFailures
      ? `${consecutiveFailures} attempts in a row failed or ended blocked`
      : consecutiveWithoutChange >= limits.consecutiveWithoutChange
        ? `${consecutiveWithoutChange} iterations in a row produced no applied change`
        : aiCallsLast24h >= limits.aiCallsPer24h
          ? `${aiCallsLast24h} AI-worker calls were made in the last 24 hours`
          : null;
    return { stop: reason !== null, reason, consecutiveFailures, consecutiveWithoutChange, aiCallsLast24h, limits };
  }

  /** Stop automatic continuation and ask the owner; returns true when the guard tripped. */
  private stopIfNoProgressLocked(goalId: string): boolean {
    const guard = this.progressGuard(goalId);
    if (!guard.stop) return false;
    const question = `Amadeus paused this goal because ${guard.reason}. The work so far is saved. `
      + "Reply to continue with a fresh set of attempts, or give new direction.";
    this.db.prepare("UPDATE goals SET status='waiting_approval', current_job_id=NULL, question=?, updated_at=? WHERE id=?")
      .run(question, this.now(), goalId);
    this.goalEvent(goalId, "progress_limit_reached", guard);
    return true;
  }

  private enqueueGoalIterationLocked(
    goalId: string,
    iterationObjective: string,
    ownerAnswer: string | null = null,
    packageStageIteration?: number,
  ): Record<string, unknown> | null {
    const goal = this.getGoal(goalId);
    const reserveMicros = Number(goal.iteration_reserve_credit_micros);
    const timestamp = this.now();
    const iteration = Number(goal.current_iteration) + 1;
    const prior = goal.current_job_id
      ? this.getJob(String(goal.current_job_id))
      : this.db.prepare("SELECT * FROM jobs WHERE goal_id=? ORDER BY goal_iteration DESC LIMIT 1").get(goalId) as Record<string, unknown> | undefined;
    const priorStage = prior ? Number(prior.package_stage_iteration ?? prior.goal_iteration) : 0;
    const stageIteration = packageStageIteration ?? (priorStage > 0 ? priorStage + 1 : 1);
    if (!Number.isSafeInteger(stageIteration) || stageIteration <= 0) throw new Error("package stage iteration must be a positive integer");
    const jobId = randomUUID();
    const evidence = goal.last_evidence ? JSON.parse(String(goal.last_evidence)) as string[] : [];
    const preservedOwnerAnswer = ownerAnswer ?? goal.answer as string | null;
    const objective = withRecordedOwnerAuthorization(formatGoalIterationObjective({
      goalObjective: String(goal.objective), successCriteria: String(goal.success_criteria),
      constraints: String(goal.constraints_text), iteration, iterationObjective,
      previousSummary: goal.last_summary as string | null, previousEvidence: evidence, ownerAnswer: preservedOwnerAnswer,
      continuousDevelopment: Number(goal.continuous_development) === 1,
    }), this.goalEvents(goalId));
    this.db.prepare(`
      INSERT INTO jobs(id, idempotency_key, objective, iteration_objective, status, reserved_cents, reserved_credit_micros, goal_id, goal_iteration, package_stage_iteration, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
    `).run(jobId, `goal:${goalId}:iteration:${iteration}`, objective, iterationObjective, reserveMicros, goalId, iteration, stageIteration, timestamp, timestamp);
    this.db.prepare("UPDATE goals SET status='active', current_iteration=?, current_job_id=?, question=NULL, answer=?, next_objective=NULL, updated_at=? WHERE id=?")
      .run(iteration, jobId, preservedOwnerAnswer, timestamp, goalId);
    this.event(jobId, "submitted", { goalId, iteration, reserveCredits: reserveMicros / 1_000_000, status: "queued" });
    this.goalEvent(goalId, "iteration_queued", { jobId, iteration, packageStageIteration: stageIteration, reserveCredits: reserveMicros / 1_000_000 });
    return this.getJob(jobId);
  }

  configureSpendingLimit(cents: number): void {
    const limit = parseNonnegativeInteger(cents, "spending limit");
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'spending_limit_cents'").run(String(limit));
    this.event(null, "spending_limit_changed", { cents: limit });
  }

  configureCreditLimits(input: { perJob: number; daily: number; weekly: number }): void {
    const entries = [
      ["credit_limit_per_job_micros", input.perJob],
      ["credit_limit_daily_micros", input.daily],
      ["credit_limit_weekly_micros", input.weekly],
    ] as const;
    for (const [, value] of entries) {
      if (!Number.isFinite(value) || value < 0) throw new Error("credit limits must be non-negative");
    }
    if (input.perJob > input.daily || input.daily > input.weekly) throw new Error("credit limits must satisfy per-job <= daily <= weekly");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) {
        this.db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(String(Math.round(value * 1_000_000)), key);
      }
      this.event(null, "credit_limits_changed", input);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pause(): void {
    this.db.prepare("UPDATE settings SET value = 'true' WHERE key = 'paused'").run();
    this.event(null, "paused", {});
  }

  resume(): void {
    this.db.prepare("UPDATE settings SET value = 'false' WHERE key = 'paused'").run();
    this.event(null, "resumed", {});
  }

  submit(input: { objective: string; idempotencyKey: string; reserveCents?: number; reserveCredits?: number }): Record<string, unknown> {
    const objective = input.objective.trim();
    const key = input.idempotencyKey.trim();
    if (!objective || !key) throw new Error("objective and idempotency key are required");
    const reserve = parseNonnegativeInteger(input.reserveCents ?? 0, "reservation");
    const reserveCredits = Number(input.reserveCredits ?? 0);
    if (!Number.isFinite(reserveCredits) || reserveCredits < 0) throw new Error("credit reservation must be non-negative");
    const reservedCreditMicros = Math.round(reserveCredits * 1_000_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return { duplicate: true, job: existing };
      }
      const timestamp = this.now();
      const status: JobStatus = "queued";
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO jobs(id, idempotency_key, objective, status, reserved_cents, reserved_credit_micros, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, key, objective, status, reserve, reservedCreditMicros, timestamp, timestamp);
      this.event(id, "submitted", { reserveCents: reserve, reserveCredits, status });
      this.db.exec("COMMIT");
      return { duplicate: false, job: this.getJob(id) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createGoal(input: {
    objective: string;
    successCriteria: string;
    constraints: string;
    idempotencyKey: string;
    reserveCredits: number;
    budgetCredits?: number;
    projectRoot?: string;
    continuous?: boolean;
  }): Record<string, unknown> {
    const objective = input.objective.trim();
    const successCriteria = input.successCriteria.trim();
    const constraints = input.constraints.trim();
    const key = input.idempotencyKey.trim();
    if (!objective || !successCriteria || !constraints || !key) throw new Error("goal objective, success criteria, constraints, and idempotency key are required");
    if (!Number.isFinite(input.reserveCredits) || input.reserveCredits <= 0) throw new Error("goal iteration reservation must be positive");
    const reserveMicros = Math.round(input.reserveCredits * 1_000_000);
    const budgetMicros = Math.round(Math.max(input.reserveCredits, input.budgetCredits ?? input.reserveCredits) * 1_000_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM goals WHERE idempotency_key=?").get(key) as Record<string, unknown> | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return { duplicate: true, goal: existing };
      }
      const goalId = randomUUID();
      const timestamp = this.now();
      this.db.prepare(`
        INSERT INTO goals(id, idempotency_key, objective, success_criteria, constraints_text, status,
          iteration_reserve_credit_micros, budget_credit_micros, continuous_development, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(goalId, key, objective, successCriteria, constraints, reserveMicros, budgetMicros, input.continuous === true ? 1 : 0, timestamp, timestamp);
      if (input.projectRoot) this.db.prepare("UPDATE goals SET project_root=? WHERE id=?").run(input.projectRoot, goalId);
      this.goalEvent(goalId, "created", { estimatedCreditsPerWorkerCall: input.reserveCredits });
      this.enqueueGoalIterationLocked(goalId, objective);
      this.db.exec("COMMIT");
      return { duplicate: false, goal: this.getGoal(goalId) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getGoal(id: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown goal: ${id}`);
    return row;
  }

  /**
   * Persist an explicit reviewed Git decision. This API deliberately accepts no
   * free-form inference: callers must bind the decision to one existing goal,
   * its current goal revision and one exact project source revision.
   */
  recordGoalGitApproval(input: {
    approvalId: string;
    goalId: string;
    goalRevision: number;
    sourceRevision: string;
    action: MilestoneGitAction;
    decision: MilestoneGitDecision;
    targetBranch?: string | null;
    targetRemote?: string | null;
    approvalReference: string;
  }): GoalGitApproval {
    void input;
    throw new Error("No authenticated Git-authority transport is configured; free-form approval references cannot create authority");
  }

  resolveGoalGitAuthorization(goalId: string, sourceRevision: string, patchDigest: string, changedPaths: string[]) {
    const goal = this.getGoal(goalId);
    const goalRevision = Number(goal.goal_revision ?? 1);
    const rows = this.db.prepare(`
      SELECT id, goal_id, goal_revision, source_revision, action, decision, target_branch, target_remote,
        target_remote_url, patch_digest, changed_paths_digest, authority_event_id, authority_actor_id,
        authority_channel, provenance_verified, grant_scope, consumption
      FROM goal_git_approvals WHERE goal_id=? AND goal_revision=? AND source_revision=? ORDER BY created_at, id
    `).all(goalId, goalRevision, sourceRevision) as Array<Record<string, unknown>>;
    const approvals: GoalGitApproval[] = rows.map((row) => ({
      schemaVersion: 2,
      approvalId: String(row.id),
      goalId: String(row.goal_id),
      goalRevision: Number(row.goal_revision),
      sourceRevision: String(row.source_revision),
      action: String(row.action) as MilestoneGitAction,
      decision: String(row.decision) as MilestoneGitDecision,
      targetBranch: row.target_branch == null ? null : String(row.target_branch),
      targetRemote: row.target_remote == null ? null : String(row.target_remote),
      targetRemoteUrl: row.target_remote_url == null ? null : String(row.target_remote_url),
      patchDigest: String(row.patch_digest ?? ""),
      changedPathsDigest: String(row.changed_paths_digest ?? ""),
      authorityEventId: String(row.authority_event_id ?? ""),
      authorityActorId: String(row.authority_actor_id ?? ""),
      authorityChannel: String(row.authority_channel ?? ""),
      provenanceVerified: Number(row.provenance_verified) === 1,
      grantScope: String(row.grant_scope ?? "single_use") as "single_use" | "bounded_standing",
      consumption: String(row.consumption ?? "available") as GoalGitApproval["consumption"],
    }));
    return resolveMilestoneGitAuthorization({ goalId, goalRevision, sourceRevision, patchDigest, changedPaths, approvals });
  }

  reserveGoalGitApprovals(goalId: string, goalRevision: number, approvalIds: string[]): boolean {
    if (!approvalIds.length) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = approvalIds.map(() => "?").join(",");
      const result = this.db.prepare(`UPDATE goal_git_approvals SET consumption='reserved'
        WHERE goal_id=? AND goal_revision=? AND consumption='available' AND id IN (${placeholders})`)
        .run(goalId, goalRevision, ...approvalIds);
      if (Number(result.changes) !== approvalIds.length) { this.db.exec("ROLLBACK"); return false; }
      this.goalEvent(goalId, "git_approvals_reserved", { goalRevision, approvalIds });
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finalizeGoalGitApprovals(goalId: string, goalRevision: number, approvalIds: string[], outcome: "consumed" | "uncertain"): void {
    if (!approvalIds.length) return;
    const placeholders = approvalIds.map(() => "?").join(",");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE goal_git_approvals SET consumption=?
        WHERE goal_id=? AND goal_revision=? AND consumption='reserved' AND id IN (${placeholders})`)
        .run(outcome, goalId, goalRevision, ...approvalIds);
      if (Number(result.changes) !== approvalIds.length) throw new Error("Git approval finalization did not match every reserved approval");
      this.goalEvent(goalId, "git_approvals_finalized", { goalRevision, approvalIds, outcome });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  goals(id?: string): Record<string, unknown> {
    const rows = id ? [this.getGoal(id)] : this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return { goals: rows };
  }

  goalEvents(id: string): Record<string, unknown>[] {
    this.getGoal(id);
    return this.db.prepare("SELECT * FROM goal_events WHERE goal_id=? ORDER BY sequence").all(id) as Record<string, unknown>[];
  }

  /** The latest worker decision recorded for a goal, or null. */
  latestGoalDecision(id: string): GoalDecision | null {
    const row = this.db.prepare("SELECT detail FROM goal_events WHERE goal_id=? AND kind='iteration_completed' ORDER BY sequence DESC LIMIT 1").get(id) as { detail: string } | undefined;
    if (!row) return null;
    try { return (JSON.parse(String(row.detail)).decision ?? null) as GoalDecision | null; }
    catch { return null; }
  }

  /**
   * The unapplied patch a recovery iteration starts from: the previous iteration's, when
   * independent verification rejected it. Null when that iteration ended any other way.
   */
  recoverySeedPatch(goalId: string, beforeIteration: number): { path: string; sha256: string } | null {
    const job = this.db.prepare("SELECT id FROM jobs WHERE goal_id=? AND goal_iteration<? ORDER BY goal_iteration DESC LIMIT 1")
      .get(goalId, beforeIteration) as { id: string } | undefined;
    if (!job) return null;
    const row = this.db.prepare("SELECT detail FROM events WHERE job_id=? AND kind='verification_recovery_required' ORDER BY sequence DESC LIMIT 1")
      .get(job.id) as { detail: string } | undefined;
    if (!row) return null;
    try {
      const patch = JSON.parse(String(JSON.parse(row.detail).detail)).patch;
      return typeof patch?.path === "string" && /^[0-9A-Fa-f]{64}$/.test(String(patch?.sha256)) ? { path: patch.path, sha256: patch.sha256 } : null;
    } catch { return null; }
  }

  pauseGoal(id: string): Record<string, unknown> {
    const goal = this.getGoal(id);
    if (goal.status !== "active") throw new Error("only an active goal can be paused");
    const timestamp = this.now();
    // One transaction with beginModelCall, so a job is either cancelled before its model call or drained after it.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE goals SET status='paused', updated_at=? WHERE id=?").run(timestamp, id);
      let cancelledJobId: string | null = null;
      if (goal.current_job_id) {
        const jobId = String(goal.current_job_id);
        this.db.prepare(`
          UPDATE jobs SET reservation_released_at=COALESCE(reservation_released_at, ?), updated_at=?
          WHERE id=? AND status='queued'
        `).run(timestamp, timestamp, jobId);
        // A just-claimed job that has not called a model yet is cancelled and requeued, not drained.
        if (this.getJob(jobId).status === "running" && !this.modelCallStarted(jobId)) {
          this.db.prepare("UPDATE jobs SET stop_requested=1, updated_at=? WHERE id=?").run(timestamp, jobId);
          this.event(jobId, "stop_requested", { reason: "goal paused before any model call" });
          cancelledJobId = jobId;
        }
      }
      this.goalEvent(id, "paused", cancelledJobId
        ? { mode: "cancel-unstarted-iteration", jobId: cancelledJobId }
        : { mode: "drain-current-iteration" });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getGoal(id);
  }

  private modelCallStarted(jobId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND kind='model_call_started' LIMIT 1").get(jobId));
  }

  /**
   * Called by a worker immediately before it starts a model. Records that the job can no longer be
   * cancelled cleanly; returns false (and the worker must not call the model) when a stop is already requested.
   */
  beginModelCall(jobId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getJob(jobId);
      const allowed = job.status === "running" && Number(job.stop_requested) !== 1;
      if (allowed) this.event(jobId, "model_call_started", {});
      this.db.exec("COMMIT");
      return allowed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * Settle a stopped job that never called a model, so it needs no reconciliation: a paused goal's job
   * goes back to the queue, a stopped goal's job fails. Returns false when this does not apply.
   */
  settleStopBeforeModelCall(jobId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getJob(jobId);
      const goal = job.goal_id ? this.getGoal(String(job.goal_id)) : null;
      if (job.status !== "running" || Number(job.stop_requested) !== 1 || this.modelCallStarted(jobId)
        || !goal || !["paused", "stopped"].includes(String(goal.status))) {
        this.db.exec("COMMIT");
        return false;
      }
      const timestamp = this.now();
      if (goal.status === "paused") {
        this.db.prepare(`UPDATE jobs SET status='queued', worker=NULL, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0,
          reservation_released_at=?, updated_at=? WHERE id=?`).run(timestamp, timestamp, jobId);
        this.event(jobId, "requeued_before_model_call", { reason: "goal paused" });
        this.goalEvent(String(goal.id), "unstarted_iteration_requeued", { jobId });
      } else {
        this.db.prepare(`UPDATE jobs SET status='failed', outcome=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0,
          reservation_released_at=?, updated_at=? WHERE id=?`)
          .run("Goal stopped before any model call; nothing to reconcile.", timestamp, timestamp, jobId);
        this.event(jobId, "stopped_before_model_call", {});
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  resumeGoal(id: string): Record<string, unknown> {
    const goal = this.getGoal(id);
    const events = this.goalEvents(id);
    const lastIteration = events.filter((event) => event.kind === "iteration_completed").at(-1);
    let lastDecision: Record<string, unknown> | null = null;
    try { lastDecision = lastIteration ? JSON.parse(String(lastIteration.detail)).decision ?? null : null; }
    catch { lastDecision = null; }
    const paused = goal.status === "paused";
    const lastExternalVerification = events.filter((event) => event.kind === "iteration_completed_external_verification").at(-1);
    let externalVerificationDetail: Record<string, unknown> | null = null;
    try { externalVerificationDetail = lastExternalVerification ? JSON.parse(String(lastExternalVerification.detail)) : null; }
    catch { externalVerificationDetail = null; }
    const externallyVerifiedLatestBlockedIteration = goal.status === "blocked"
      && Number(goal.continuous_development) === 1
      && !goal.current_job_id
      && !String(goal.question ?? "").trim()
      && externalVerificationDetail?.decisionStatus === "blocked"
      && Number(externalVerificationDetail?.iteration) === Number(goal.current_iteration);
    const recoverableBlockedStream = goal.status === "blocked"
      && Number(goal.continuous_development) === 1
      && !goal.current_job_id
      && !String(goal.question ?? "").trim()
      && (lastDecision?.status === "blocked" || externallyVerifiedLatestBlockedIteration);
    const externallyVerifiedBlockedDecision = goal.status === "completed"
      && Number(goal.continuous_development) === 1
      && !goal.current_job_id
      && !String(goal.question ?? "").trim()
      && Boolean(externalVerificationDetail?.jobId)
      && externalVerificationDetail?.receiptDecisionStatus === "blocked"
      && Number(externalVerificationDetail?.iteration) === Number(goal.current_iteration);
    const originHostHandoff = goal.status === "blocked"
      && Number(goal.continuous_development) === 1
      && !goal.current_job_id
      && !String(goal.question ?? "").trim()
      && lastDecision?.status === "blocked"
      && Boolean(String((lastDecision.hostHandoff as { action?: unknown } | undefined)?.action ?? "").trim());
    if (originHostHandoff && lastDecision) {
      return {
        ...goal,
        nextAction: "execute_origin_host_handoff_and_continue",
        originHostHandoff: {
          action: String((lastDecision.hostHandoff as { action: string }).action),
          summary: String(lastDecision.summary ?? goal.last_summary ?? "Execute the preserved host-side step."),
          evidence: Array.isArray(lastDecision.evidence) ? lastDecision.evidence : [],
          reason: "The latest blocked decision has no worker objective or owner question; continue the saved activity on the originating host without queuing another worker.",
        },
      };
    }
    if (!paused && !recoverableBlockedStream && !externallyVerifiedBlockedDecision) {
      throw new Error("only a paused goal, an explicitly resumed blocked continuous goal without an owner question, or a verified false-completion correction can be resumed");
    }
    const current = paused && goal.current_job_id ? this.getJob(String(goal.current_job_id)) : null;
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE goals SET status='active', updated_at=? WHERE id=?").run(timestamp, id);
      this.goalEvent(id, externallyVerifiedBlockedDecision ? "false_completion_corrected_and_resumed" : recoverableBlockedStream ? "blocked_goal_resumed" : "resumed",
        externallyVerifiedBlockedDecision ? { previousJobId: externalVerificationDetail?.jobId ?? null, previousSummary: goal.last_summary ?? null, reason: "The latest externally verified receipt records a blocked decision; the earlier reconcile incorrectly marked the continuous goal completed. Reopen the same goal and preserve its evidence." } : recoverableBlockedStream ? {
          previousJobId: lastIteration ? JSON.parse(String(lastIteration.detail)).jobId ?? null : null,
          previousSummary: goal.last_summary ?? null,
          reason: "Owner explicitly resumed the same continuous goal; prior evidence and scope are preserved.",
        } : {});
      const automaticContinuation = recoverableBlockedStream || externallyVerifiedBlockedDecision;
      if (automaticContinuation && this.stopIfNoProgressLocked(id)) {
        this.db.exec("COMMIT");
        return this.getGoal(id);
      }
      if (automaticContinuation || !current || terminalStatuses.has(current.status as JobStatus)) {
        this.enqueueGoalIterationLocked(id, String(goal.next_objective ?? goal.objective), goal.answer as string | null);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getGoal(id);
  }

  retryFailedGoal(id: string, detail: string): Record<string, unknown> {
    const reason = detail.trim();
    if (!reason) throw new Error("retry reason is required");
    const goal = this.getGoal(id);
    if (goal.status === "paused" && goal.current_job_id) {
      const current = this.getJob(String(goal.current_job_id));
      if (current.status === "queued" && Number(current.goal_iteration) > 1) {
        const prior = this.getGoalIterationJob(id, Number(current.goal_iteration) - 1);
        if (prior?.status === "failed") {
          const timestamp = this.now();
          this.db.prepare(`
            UPDATE jobs SET reservation_released_at=COALESCE(reservation_released_at, ?), updated_at=?
            WHERE id=? AND status='queued'
          `).run(timestamp, timestamp, String(current.id));
          const expectedStage = Number(prior.package_stage_iteration ?? prior.goal_iteration);
          if (Number(current.package_stage_iteration) !== expectedStage) {
            this.db.prepare("UPDATE jobs SET package_stage_iteration=?, updated_at=? WHERE id=?").run(expectedStage, this.now(), String(current.id));
            this.goalEvent(id, "retry_stage_corrected", { failedJobId: prior.id, replacementJobId: current.id, packageStageIteration: expectedStage });
          }
          return this.getGoal(id);
        }
      }
    }
    if (goal.status !== "blocked") throw new Error("only a blocked goal can queue a corrected replacement");
    if (!goal.current_job_id) {
      const rejected = this.db.prepare("SELECT * FROM jobs WHERE goal_id=? ORDER BY goal_iteration DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
      const rejectedStage = rejected ? Number(rejected.package_stage_iteration ?? rejected.goal_iteration) : 0;
      const priorStage = rejectedStage > 1 ? this.getGoalPackageStageJob(id, rejectedStage - 1) : null;
      const latestIteration = this.goalEvents(id).filter((event) => event.kind === "iteration_completed").at(-1);
      let latestDecision: Record<string, unknown> | null = null;
      let latestJobId = "";
      try {
        const parsed = latestIteration ? JSON.parse(String(latestIteration.detail)) : null;
        latestDecision = parsed?.decision ?? null;
        latestJobId = String(parsed?.jobId ?? "");
      } catch { latestDecision = null; }
      const recovery = latestDecision?.recovery as Record<string, unknown> | undefined;
      const recoverableTechnicalBlock = Boolean(rejected && rejected.status === "completed"
        && latestJobId === String(rejected.id) && latestDecision?.status === "blocked"
        && recovery?.scope === "same-approved-scope" && String(recovery?.diagnosis ?? "").trim()
        && String(recovery?.nextObjective ?? "").trim());
      if (!rejected || rejected.status !== "completed" || (!recoverableTechnicalBlock && !priorStage)) {
        throw new Error("blocked goal has no failed or later-stage-rejected iteration to replace");
      }
      const replacedStageJob = recoverableTechnicalBlock ? rejected : priorStage!;
      const replacementStage = recoverableTechnicalBlock ? rejectedStage : rejectedStage - 1;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.stopIfNoProgressLocked(id)) { this.db.exec("COMMIT"); return this.getGoal(id); }
        this.goalEvent(id, "retry_authorized", { rejectedJobId: rejected.id, replacedStageJobId: replacedStageJob.id,
          reason, recoveryKind: recoverableTechnicalBlock ? "corrected-technical-block" : "later-stage-rejection" });
        const replacement = this.enqueueGoalIterationLocked(id, String(goal.objective), goal.answer as string | null, replacementStage);
        if (!replacement) throw new Error("replacement iteration could not be queued");
        const timestamp = this.now();
        this.db.prepare("UPDATE goals SET status='paused', updated_at=? WHERE id=?").run(timestamp, id);
        this.db.prepare("UPDATE jobs SET reservation_released_at=?, updated_at=? WHERE id=? AND status='queued'")
          .run(timestamp, timestamp, String(replacement.id));
        this.goalEvent(id, "retry_queued_paused", { rejectedJobId: rejected.id, replacedStageJobId: replacedStageJob.id,
          replacementJobId: replacement.id, recoveryKind: recoverableTechnicalBlock ? "corrected-technical-block" : "later-stage-rejection" });
        this.db.exec("COMMIT");
        return this.getGoal(id);
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    const current = this.getJob(String(goal.current_job_id));
    if (current.status !== "failed") throw new Error("only a verified failed iteration can be replaced");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.stopIfNoProgressLocked(id)) { this.db.exec("COMMIT"); return this.getGoal(id); }
      this.goalEvent(id, "retry_authorized", { failedJobId: current.id, reason });
      const failedStage = Number(current.package_stage_iteration ?? current.goal_iteration);
      const replacement = this.enqueueGoalIterationLocked(id, String(goal.next_objective ?? goal.objective), goal.answer as string | null, failedStage);
      if (!replacement) throw new Error("replacement iteration could not be queued");
      const timestamp = this.now();
      this.db.prepare("UPDATE goals SET status='paused', updated_at=? WHERE id=?").run(timestamp, id);
      this.db.prepare("UPDATE jobs SET reservation_released_at=?, updated_at=? WHERE id=? AND status='queued'")
        .run(timestamp, timestamp, String(replacement.id));
      this.goalEvent(id, "retry_queued_paused", { failedJobId: current.id, replacementJobId: replacement.id });
      this.db.exec("COMMIT");
      return this.getGoal(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  queueTechnicalRecovery(id: string, sourceFingerprint: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(sourceFingerprint)) throw new Error("Recovery requires a verified source fingerprint");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const goal = this.getGoal(id);
      const events = this.goalEvents(id);
      const latest = events.filter(event => event.kind === "iteration_completed").at(-1);
      const detail = latest ? JSON.parse(String(latest.detail)) : null;
      const recovery = detail?.decision?.recovery as GoalDecision["recovery"];
      const alreadyTried = events.some(event => event.kind === "technical_recovery_queued" && JSON.parse(String(event.detail)).sourceFingerprint === sourceFingerprint);
      if (this.setting("paused") === "true" || goal.status !== "blocked" || goal.current_job_id
        || detail?.decision?.status !== "blocked" || !recovery || recovery.scope !== "same-approved-scope"
        || !recovery.diagnosis?.trim() || !recovery.nextObjective?.trim() || alreadyTried
        || hasExplicitAttemptRestriction(String(goal.constraints_text))
        || this.hasRunningConflict(id) || this.hasUncertainConflict(id)) {
        this.db.exec("COMMIT"); return false;
      }
      const previous = this.getJob(String(detail.jobId));
      if (previous.status !== "completed") { this.db.exec("COMMIT"); return false; }
      if (this.stopIfNoProgressLocked(id)) { this.db.exec("COMMIT"); return false; }
      const objective = `Technical recovery of the unfinished goal. Observed cause: ${recovery.diagnosis}\nRepair plan: ${recovery.nextObjective}\nDiagnose from the preserved evidence, correct only within the existing writable scope, and verify the correction before resuming the original task. Do not repeat the failed operation unchanged. Original completion criteria and all authority restrictions remain in force.`;
      const next = this.enqueueGoalIterationLocked(id, objective, goal.answer as string | null, Number(previous.package_stage_iteration ?? previous.goal_iteration));
      this.goalEvent(id, "technical_recovery_queued", { previousJobId: previous.id, jobId: next!.id, sourceFingerprint, diagnosis: recovery.diagnosis });
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  answerGoal(id: string, answer: string): Record<string, unknown> {
    if (!answer.trim()) throw new Error("answer is required");
    const goal = this.getGoal(id);
    if (goal.status !== "waiting_approval") throw new Error("goal is not waiting for approval");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE goals SET answer=?, status='active', goal_revision=goal_revision+1, updated_at=? WHERE id=?")
        .run(answer.trim(), this.now(), id);
      this.goalEvent(id, "answered", { answer: answer.trim(), previousGoalRevision: Number(goal.goal_revision ?? 1),
        goalRevision: Number(goal.goal_revision ?? 1) + 1 });
      this.enqueueGoalIterationLocked(id, String(goal.next_objective ?? goal.objective), answer.trim());
      this.db.exec("COMMIT");
      return this.getGoal(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  stopGoal(id: string, detail: string): Record<string, unknown> {
    const reason = detail.trim();
    if (!reason) throw new Error("stop reason is required");
    const goal = this.getGoal(id);
    if (["completed", "blocked", "budget_limited", "stopped"].includes(String(goal.status))) throw new Error("goal is already terminal");
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (goal.current_job_id) {
        const job = this.getJob(String(goal.current_job_id));
        if (job.status === "running") this.db.prepare("UPDATE jobs SET stop_requested=1, updated_at=? WHERE id=?").run(timestamp, String(job.id));
        if (job.status === "queued") this.db.prepare("UPDATE jobs SET status='failed', outcome=?, reservation_released_at=?, updated_at=? WHERE id=?")
          .run(`Goal stopped before dispatch: ${reason}`, timestamp, timestamp, String(job.id));
      }
      this.db.prepare("UPDATE goals SET status='stopped', updated_at=? WHERE id=?").run(timestamp, id);
      this.goalEvent(id, "stopped", { reason });
      this.db.exec("COMMIT");
      return this.getGoal(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Interrupt only the current stalled iteration while preserving the unfinished goal for reconciliation and retry. */
  requestStalledIterationRecovery(id: string, detail: string): Record<string, unknown> {
    const reason = detail.trim();
    if (!reason) throw new Error("stalled iteration recovery reason is required");
    const goal = this.getGoal(id);
    if (goal.status !== "active" || !goal.current_job_id) throw new Error("goal has no active iteration to recover");
    const job = this.getJob(String(goal.current_job_id));
    if (job.status !== "running") throw new Error("goal iteration is not running");
    const timestamp = this.now();
    this.db.prepare("UPDATE jobs SET stop_requested=1, updated_at=? WHERE id=?").run(timestamp, String(job.id));
    this.event(String(job.id), "stalled_recovery_requested", { reason });
    this.goalEvent(id, "stalled_recovery_requested", { jobId: job.id, reason });
    return { goal: this.getGoal(id), job: this.getJob(String(job.id)) };
  }

  finishGoalIteration(jobId: string, outcome: string, resultArtifactPath: string | undefined, decision: GoalDecision): Record<string, unknown> {
    const job = this.getJob(jobId);
    if (job.status !== "running" || !job.goal_id) throw new Error("job is not a running goal iteration");
    const goalId = String(job.goal_id);
    const goal = this.getGoal(goalId);
    if (String(goal.current_job_id) !== jobId) throw new Error("job is not the goal's current iteration");
    const timestamp = this.now();
    const vagueContinuation = decision.status === "continue" && (!decision.remainingCriterion
      || /\b(?:review|implement|continue)\s+(?:the\s+)?next\s+(?:bounded\s+)?(?:relationship|step)\b|\bcontinue\s+the\s+persistent\b/i.test(decision.nextObjective ?? ""));
    const effectiveNextObjective = vagueContinuation
      ? `Completion audit for the persistent goal. Check every success criterion against current authoritative code, tests, and saved evidence. Implement and verify all remaining directly related in-scope work as one coherent milestone. Complete the goal if every criterion is evidenced; otherwise continue only with one exact unmet criterion and the implementation-and-verification work needed to close it. Legacy or vague reported gap: ${decision.remainingCriterion ?? decision.nextObjective}`
      : decision.nextObjective;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE jobs SET status='completed', outcome=?, result_artifact_path=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, reservation_released_at=?, updated_at=? WHERE id=?")
        .run(outcome.trim(), resultArtifactPath ?? null, timestamp, timestamp, jobId);
      this.event(jobId, "completed", { outcome: outcome.trim(), resultArtifactPath: resultArtifactPath ?? null, goalDecision: decision.status });
      this.db.prepare("UPDATE goals SET last_summary=?, last_evidence=?, next_objective=?, question=?, updated_at=? WHERE id=?")
        .run(decision.summary, JSON.stringify(decision.evidence), effectiveNextObjective, decision.question, timestamp, goalId);
      this.goalEvent(goalId, "iteration_completed", { jobId, iteration: job.goal_iteration, decision });
      if (vagueContinuation) this.goalEvent(goalId, "completion_audit_queued", { jobId, reportedNextObjective: decision.nextObjective,
        reportedRemainingCriterion: decision.remainingCriterion ?? null, effectiveNextObjective });
      const interrupted = ["paused", "stopped"].includes(String(goal.status));
      if (!interrupted && decision.status === "complete" && Number(goal.continuous_development) === 1 && decision.nextStreamObjective?.trim()) {
        const next = decision.nextStreamObjective.trim();
        this.db.prepare("UPDATE goals SET status='active', current_job_id=NULL, next_objective=?, updated_at=? WHERE id=?")
          .run(next, timestamp, goalId);
        this.goalEvent(goalId, "stream_advanced", { fromJobId: jobId, nextObjective: next });
        if (!this.stopIfNoProgressLocked(goalId)) this.enqueueGoalIterationLocked(goalId, next);
      } else if (!interrupted && decision.status === "complete") {
        this.db.prepare("UPDATE goals SET status='completed', current_job_id=NULL, updated_at=? WHERE id=?").run(timestamp, goalId);
      } else if (!interrupted && decision.status === "blocked") {
        this.db.prepare("UPDATE goals SET status='blocked', current_job_id=NULL, updated_at=? WHERE id=?").run(timestamp, goalId);
        this.stopIfNoProgressLocked(goalId);
      } else if (!interrupted && decision.status === "needs_approval") {
        this.db.prepare("UPDATE goals SET status='waiting_approval', current_job_id=NULL, updated_at=? WHERE id=?").run(timestamp, goalId);
      } else if (!interrupted && decision.status === "continue") {
        if (!this.stopIfNoProgressLocked(goalId)) this.enqueueGoalIterationLocked(goalId, effectiveNextObjective!);
      } else {
        this.db.prepare("UPDATE goals SET current_job_id=NULL, next_objective=?, updated_at=? WHERE id=?")
          .run(effectiveNextObjective, timestamp, goalId);
      }
      this.db.exec("COMMIT");
      return this.getGoal(goalId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  promoteVerifiedGoalIteration(input: {
    jobId: string;
    recoveryStrategy: string;
    outcome: string;
    resultArtifactPath: string;
    decision: GoalDecision;
    patchPath: string;
    patchSha256: string;
    patchBytes: number;
    changedFiles: number;
    changedLines: number;
    reason: string;
  }): Record<string, unknown> {
    const job = this.getJob(input.jobId);
    if (job.status !== "failed" || !job.goal_id) throw new Error("only a failed goal iteration can be recovered");
    const hasRecoveryEvidence = this.events(input.jobId).some((event) => {
      if (event.kind !== "recoverable_failure") return false;
      try {
        const wrapper = JSON.parse(String(event.detail)) as { detail?: unknown };
        const evidence = JSON.parse(String(wrapper.detail)) as Record<string, unknown>;
        return evidence.schemaVersion === 1
          && evidence.recoveryStrategy === input.recoveryStrategy
          && evidence.authoritativeWorkspaceModified === false;
      } catch { return false; }
    });
    if (!hasRecoveryEvidence) throw new Error("failed iteration has no matching structured recovery evidence");
    const goalId = String(job.goal_id);
    const goal = this.getGoal(goalId);
    if (goal.status !== "blocked" || String(goal.current_job_id) !== input.jobId) throw new Error("failed iteration is not the blocked goal's current job");
    if (input.decision.status !== "continue" || !input.decision.nextObjective?.trim()) throw new Error("recovered decision must continue to the next verified stage");
    if (this.patchReceipts(input.jobId).records.length) throw new Error("failed iteration already has a patch receipt");
    const reason = input.reason.trim();
    if (!reason) throw new Error("recovery reason is required");
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO patch_receipts(
          job_id, attempt, patch_path, patch_sha256, patch_bytes, changed_files,
          changed_lines, checkpoint_receipt, applied, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(input.jobId, Number(job.attempt_count), input.patchPath, input.patchSha256.toUpperCase(), input.patchBytes,
        input.changedFiles, input.changedLines, `deterministic recovery (${input.recoveryStrategy}): authoritative workspace was not modified`, timestamp);
      this.event(input.jobId, "patch_receipt_recorded", { attempt: Number(job.attempt_count), patchSha256: input.patchSha256.toUpperCase(),
        checkpointReceipt: `deterministic recovery (${input.recoveryStrategy}): authoritative workspace was not modified`, applied: false });
      this.db.prepare("UPDATE jobs SET status='completed', outcome=?, result_artifact_path=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, reservation_released_at=COALESCE(reservation_released_at, ?), updated_at=? WHERE id=?")
        .run(input.outcome.trim(), input.resultArtifactPath, timestamp, timestamp, input.jobId);
      this.event(input.jobId, "deterministic_failure_recovered", { reason, resultArtifactPath: input.resultArtifactPath,
        patchSha256: input.patchSha256.toUpperCase(), changedFiles: input.changedFiles, changedLines: input.changedLines,
        recoveryStrategy: input.recoveryStrategy });
      this.db.prepare("UPDATE goals SET status='active', last_summary=?, last_evidence=?, next_objective=?, question=NULL, updated_at=? WHERE id=?")
        .run(input.decision.summary, JSON.stringify(input.decision.evidence), input.decision.nextObjective, timestamp, goalId);
      this.goalEvent(goalId, "iteration_recovered", { jobId: input.jobId, iteration: job.goal_iteration, decision: input.decision, reason });
      if (!this.stopIfNoProgressLocked(goalId)) this.enqueueGoalIterationLocked(goalId, input.decision.nextObjective);
      this.db.exec("COMMIT");
      return this.getGoal(goalId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getJob(id: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown job: ${id}`);
    return row;
  }

  getGoalIterationJob(goalId: string, iteration: number): Record<string, unknown> | null {
    this.getGoal(goalId);
    if (!Number.isSafeInteger(iteration) || iteration <= 0) throw new Error("goal iteration must be a positive integer");
    const row = this.db.prepare("SELECT * FROM jobs WHERE goal_id=? AND goal_iteration=?").get(goalId, iteration) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  getGoalPackageStageJob(goalId: string, stageIteration: number): Record<string, unknown> | null {
    this.getGoal(goalId);
    if (!Number.isSafeInteger(stageIteration) || stageIteration <= 0) throw new Error("package stage iteration must be a positive integer");
    const row = this.db.prepare(`
      SELECT * FROM jobs
      WHERE goal_id=? AND COALESCE(package_stage_iteration, goal_iteration)=? AND status='completed'
      ORDER BY goal_iteration DESC LIMIT 1
    `).get(goalId, stageIteration) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  status(id?: string): Record<string, unknown> {
    const paused = this.setting("paused") === "true";
    const spendingLimitCents = Number(this.setting("spending_limit_cents"));
    const rows = id
      ? [this.getJob(id)]
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[];
    const liveStatuses = new Set(["queued", "running", "waiting_question", "uncertain"]);
    const workerStatuses = new Set(["running", "waiting_question", "uncertain"]);
    const goals = this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[];
    const normalizedGoals = goals.map((goal) => {
      const currentJobId = goal.current_job_id == null ? null : String(goal.current_job_id);
      const currentJob = currentJobId ? this.db.prepare("SELECT status FROM jobs WHERE id=?").get(currentJobId) as { status?: string } | undefined : undefined;
      const live = currentJob?.status && liveStatuses.has(currentJob.status);
      return live || currentJobId == null
        ? goal
        : { ...goal, historical_job_id: currentJobId, current_job_id: null };
    });
    const activeJobs = rows.filter((job) => workerStatuses.has(String(job.status)));
    const queuedJobs = rows.filter((job) => String(job.status) === "queued");
    const outstandingCreditMicros = (this.db.prepare(`
      SELECT COALESCE(SUM(reserved_credit_micros), 0) total FROM jobs
      WHERE (status IN ('running', 'waiting_question', 'uncertain')
        OR (status='queued' AND (goal_id IS NULL OR goal_id IN (SELECT id FROM goals WHERE status='active'))))
        AND reservation_released_at IS NULL
    `).get() as { total: number }).total;
    return {
      paused,
      spendingLimitCents,
      financialAdmissionEnforced: false,
      progressLimits: this.progressLimits(),
      creditLimits: {
        perJob: Number(this.setting("credit_limit_per_job_micros")) / 1_000_000,
        daily: Number(this.setting("credit_limit_daily_micros")) / 1_000_000,
        weekly: Number(this.setting("credit_limit_weekly_micros")) / 1_000_000,
      },
      outstandingReservationCredits: outstandingCreditMicros / 1_000_000,
      goals: normalizedGoals,
      jobs: rows,
      activeJobs,
      activeGoalIds: [...new Set(activeJobs.map((job) => job.goal_id).filter(Boolean))],
      queuedJobs,
      queuedGoalIds: [...new Set(queuedJobs.map((job) => job.goal_id).filter(Boolean))],
    };
  }

  recordUsage(input: {
    jobId: string;
    attempt: number;
    model: string;
    usage: Partial<CodexUsage>;
    reservedCredits: number;
  }): Record<string, unknown> {
    this.getJob(input.jobId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) throw new Error("attempt must be a positive integer");
    if (!Number.isFinite(input.reservedCredits) || input.reservedCredits < 0) throw new Error("reservedCredits must be non-negative");
    const usage = validateUsage(input.usage);
    if (input.model !== lunaRateCard.model) {
      this.recordProviderUsage({ jobId: input.jobId, attempt: input.attempt, provider: "codex", model: input.model,
        sessionId: `${input.jobId}-a${input.attempt}`, requestId: null, durationMs: null, durationApiMs: null,
        tokenUsageAvailable: true, inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens,
        cacheWriteInputTokens: usage.cache_write_input_tokens, outputTokens: usage.output_tokens,
        actualProviderCredits: null, reservedCredits: input.reservedCredits });
      return this.usage(input.jobId);
    }
    const estimatedCreditMicros = estimateCreditMicros(usage, lunaRateCard);
    const reservedCreditMicros = Math.round(input.reservedCredits * 1_000_000);
    this.db.prepare(`
      INSERT INTO usage_records(
        job_id, attempt, model, input_tokens, cached_input_tokens,
        cache_write_input_tokens, output_tokens, reasoning_output_tokens,
        estimated_credit_micros, reserved_credit_micros,
        actual_provider_credit_micros, rate_card_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      input.jobId, input.attempt, input.model, usage.input_tokens,
      usage.cached_input_tokens, usage.cache_write_input_tokens,
      usage.output_tokens, usage.reasoning_output_tokens,
      estimatedCreditMicros, reservedCreditMicros, lunaRateCard.source, this.now(),
    );
    this.event(input.jobId, "usage_recorded", {
      attempt: input.attempt,
      model: input.model,
      usage,
      estimatedCredits: estimatedCreditMicros / 1_000_000,
      reservedCredits: input.reservedCredits,
      actualProviderCredits: null,
    });
    return this.usage(input.jobId);
  }

  recordProviderUsage(input: {
    jobId: string;
    attempt: number;
    provider: string;
    model: string | null;
    sessionId: string;
    requestId: string | null;
    durationMs: number | null;
    durationApiMs: number | null;
    tokenUsageAvailable: boolean;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    actualProviderCredits: null;
    reservedCredits: number;
  }): void {
    this.getJob(input.jobId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) throw new Error("attempt must be a positive integer");
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(input.provider)) throw new Error("provider is invalid");
    if (!input.sessionId.trim()) throw new Error("provider sessionId is required");
    if (!Number.isFinite(input.reservedCredits) || input.reservedCredits < 0) throw new Error("reservedCredits must be non-negative");
    for (const [name, value] of [["durationMs", input.durationMs], ["durationApiMs", input.durationApiMs]] as const) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must be null or a non-negative integer`);
    }
    const tokenFields = [input.inputTokens, input.cachedInputTokens, input.cacheWriteInputTokens, input.outputTokens];
    if (input.tokenUsageAvailable) {
      if (tokenFields.some((value) => value === null || !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Available provider token usage requires non-negative integer token fields");
      }
    } else if (tokenFields.some((value) => value !== null)) {
      throw new Error("Unavailable provider token usage must use null token fields");
    }
    if (input.actualProviderCredits !== null) {
      throw new Error("Provider charges are unavailable and must remain null");
    }
    this.event(input.jobId, "provider_usage_recorded", {
      attempt: input.attempt,
      provider: input.provider,
      model: input.model,
      sessionId: input.sessionId,
      requestId: input.requestId,
      durationMs: input.durationMs,
      durationApiMs: input.durationApiMs,
      tokenUsageAvailable: input.tokenUsageAvailable,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheWriteInputTokens: input.cacheWriteInputTokens,
      outputTokens: input.outputTokens,
      rateCardEstimate: null,
      actualProviderCredits: null,
      reservedCredits: input.reservedCredits,
    });
  }

  usage(jobId?: string): Record<string, unknown> {
    if (jobId) this.getJob(jobId);
    const rows = (jobId
      ? this.db.prepare("SELECT * FROM usage_records WHERE job_id = ? ORDER BY attempt").all(jobId)
      : this.db.prepare("SELECT * FROM usage_records ORDER BY created_at").all()) as Record<string, unknown>[];
    const totals = rows.reduce<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; estimatedCreditMicros: number; actualProviderCreditMicros: number; actualProviderRecords: number }>((sum, row) => ({
      inputTokens: sum.inputTokens + Number(row.input_tokens),
      cachedInputTokens: sum.cachedInputTokens + Number(row.cached_input_tokens),
      outputTokens: sum.outputTokens + Number(row.output_tokens),
      estimatedCreditMicros: sum.estimatedCreditMicros + Number(row.estimated_credit_micros),
      actualProviderCreditMicros: row.actual_provider_credit_micros === null
        ? sum.actualProviderCreditMicros
        : sum.actualProviderCreditMicros + Number(row.actual_provider_credit_micros),
      actualProviderRecords: sum.actualProviderRecords + (row.actual_provider_credit_micros === null ? 0 : 1),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCreditMicros: 0, actualProviderCreditMicros: 0, actualProviderRecords: 0 });
    return {
      records: rows,
      providerRecords: this.events(jobId).filter((event) => event.kind === "provider_usage_recorded").map((event) => JSON.parse(String(event.detail))),
      totals: {
        ...totals,
        estimatedCredits: totals.estimatedCreditMicros / 1_000_000,
        actualProviderCredits: totals.actualProviderRecords === rows.length && rows.length > 0
          ? totals.actualProviderCreditMicros / 1_000_000
          : null,
      },
    };
  }

  recordPatchReceipt(input: {
    jobId: string;
    attempt: number;
    patchPath: string;
    patchSha256: string;
    patchBytes: number;
    changedFiles: number;
    changedLines: number;
    checkpointReceipt?: string;
    applied?: boolean;
  }): Record<string, unknown> {
    this.getJob(input.jobId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) throw new Error("attempt must be a positive integer");
    if (!input.patchPath.trim()) throw new Error("patchPath is required");
    if (!/^[0-9a-f]{64}$/i.test(input.patchSha256)) throw new Error("patchSha256 must be a SHA-256 digest");
    for (const [name, value] of [["patchBytes", input.patchBytes], ["changedFiles", input.changedFiles], ["changedLines", input.changedLines]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    const applied = input.applied === true;
    const checkpoint = input.checkpointReceipt?.trim() || null;
    if (applied && checkpoint === null) throw new Error("an applied patch requires a verified checkpoint receipt");
    this.db.prepare(`
      INSERT INTO patch_receipts(
        job_id, attempt, patch_path, patch_sha256, patch_bytes, changed_files,
        changed_lines, checkpoint_receipt, applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.jobId, input.attempt, input.patchPath, input.patchSha256.toUpperCase(),
      input.patchBytes, input.changedFiles, input.changedLines, checkpoint,
      applied ? 1 : 0, this.now(),
    );
    this.event(input.jobId, "patch_receipt_recorded", {
      attempt: input.attempt,
      patchSha256: input.patchSha256.toUpperCase(),
      checkpointReceipt: checkpoint,
      applied,
    });
    return this.patchReceipts(input.jobId);
  }

  patchReceipts(jobId?: string): { records: Record<string, unknown>[] } {
    if (jobId) this.getJob(jobId);
    const records = (jobId
      ? this.db.prepare("SELECT * FROM patch_receipts WHERE job_id=? ORDER BY attempt").all(jobId)
      : this.db.prepare("SELECT * FROM patch_receipts ORDER BY created_at").all()) as Record<string, unknown>[];
    return { records };
  }

  events(jobId?: string): Record<string, unknown>[] {
    return (jobId
      ? this.db.prepare("SELECT * FROM events WHERE job_id=? ORDER BY sequence").all(jobId)
      : this.db.prepare("SELECT * FROM events ORDER BY sequence").all()) as Record<string, unknown>[];
  }

  recordAuditNote(id: string, kind: string, detail: string): void {
    const job = this.getJob(id);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(kind)) throw new Error("audit note kind is invalid");
    if (!detail.trim()) throw new Error("audit note detail is required");
    this.event(id, kind, { detail: detail.trim() });
    // Mirror orchestrator route/step events into the goal stream so the
    // originating chat can wake before iteration completion.
    if (job.goal_id && ["route_selected", "route_step_started", "route_step_completed", "worker_progress"].includes(kind)) {
      this.goalEvent(String(job.goal_id), kind, { jobId: id, detail: detail.trim() });
    }
  }

  /** Persist milestone Git outcome on the job and goal without altering product status. */
  recordMilestoneGitAutomation(input: {
    jobId: string;
    goalId: string;
    result: {
      status: string;
      branch: string | null;
      commit: string | null;
      commitMessage: string | null;
      remote: string | null;
      pushOutcome: string;
      reason: string;
      brief: string;
    };
  }): void {
    this.getGoal(input.goalId);
    const payload = {
      schemaVersion: 1,
      ...input.result,
      brief: input.result.brief || [
        `status=${input.result.status}`,
        `commitMessage=${input.result.commitMessage ?? "(none)"}`,
        `sha=${input.result.commit ?? "(none)"}`,
        `branch=${input.result.branch ?? "(none)"}`,
        `remote=${input.result.remote ?? "(none)"}`,
        `push=${input.result.pushOutcome}`,
        `detail=${input.result.reason}`,
      ].join("; "),
    };
    this.recordAuditNote(input.jobId, "milestone_git_automation", JSON.stringify(payload));
    this.goalEvent(input.goalId, "milestone_git_automation", { jobId: input.jobId, ...payload });
  }

  /** Surface the exact Git brief on the durable goal summary used by owner work-status views. */
  attachMilestoneGitBrief(goalId: string, brief: string): void {
    const text = brief.trim();
    if (!text) return;
    const goal = this.getGoal(goalId);
    const summary = String(goal.last_summary ?? "").trim();
    const stamped = summary.includes("Milestone Git:")
      ? summary.replace(/Milestone Git:.*$/s, `Milestone Git: ${text}`)
      : `${summary}\n\nMilestone Git: ${text}`.trim();
    this.db.prepare("UPDATE goals SET last_summary=?, updated_at=? WHERE id=?").run(stamped, this.now(), goalId);
  }

  correctCompletedOutcome(id: string, outcome: string, reason: string): void {
    const job = this.getJob(id);
    if (job.status !== "completed") throw new Error("only completed outcomes can be corrected");
    if (!outcome.trim() || !reason.trim()) throw new Error("corrected outcome and reason are required");
    const previous = String(job.outcome ?? "");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE jobs SET outcome=?, updated_at=? WHERE id=?").run(outcome.trim(), this.now(), id);
      this.event(id, "completed_outcome_corrected", { reason: reason.trim(), previous, outcome: outcome.trim() });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private expireStaleLocked(timestamp: string): string[] {
    const stale = this.db.prepare(
      "SELECT id, worker, lease_expires_at FROM jobs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"
    ).all(timestamp) as { id: string; worker: string | null; lease_expires_at: string }[];
    for (const job of stale) {
      this.db.prepare(`
        UPDATE jobs SET status='uncertain', outcome=?, heartbeat_at=NULL,
          lease_expires_at=NULL, stop_requested=0, updated_at=? WHERE id=?
      `).run("Worker lease expired; reconcile before replacement dispatch.", timestamp, job.id);
      const linked = this.db.prepare("SELECT goal_id FROM jobs WHERE id=?").get(job.id) as { goal_id: string | null };
      if (linked.goal_id) {
        this.db.prepare("UPDATE goals SET status='uncertain', updated_at=? WHERE id=? AND status!='stopped'").run(timestamp, linked.goal_id);
        this.goalEvent(linked.goal_id, "uncertain", { jobId: job.id, reason: "lease_expired" });
      }
      this.event(job.id, "lease_expired", { worker: job.worker, leaseExpiresAt: job.lease_expires_at });
    }
    return stale.map((job) => job.id);
  }

  expireStale(): string[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ids = this.expireStaleLocked(this.now());
      this.db.exec("COMMIT");
      return ids;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasUncertainConflict(goalId?: string): boolean {
    const root = goalId ? this.getGoal(goalId).project_root as string | null : null;
    const unresolved = this.db.prepare("SELECT g.project_root FROM jobs j LEFT JOIN goals g ON g.id=j.goal_id WHERE j.status='uncertain'").all() as { project_root: string | null }[];
    return unresolved.some((item) => projectRootsOverlap(root, item.project_root));
  }

  hasRunningConflict(goalId?: string): boolean {
    const root = goalId ? this.getGoal(goalId).project_root as string | null : null;
    const running = this.db.prepare(`
      SELECT g.project_root FROM jobs j LEFT JOIN goals g ON g.id=j.goal_id
      WHERE j.status='running'
    `).all() as { project_root: string | null }[];
    return running.some((item) => projectRootsOverlap(root, item.project_root));
  }

  claim(worker: string, leaseSeconds = 600, goalId?: string): Record<string, unknown> | null {
    if (!worker.trim()) throw new Error("worker is required");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("leaseSeconds must be a positive integer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = this.now();
      this.expireStaleLocked(timestamp);
      if (this.setting("paused") === "true") {
        this.db.exec("COMMIT");
        return null;
      }
      if (goalId && this.hasUncertainConflict(goalId)) {
        this.db.exec("COMMIT");
        return null;
      }
      if (goalId && this.hasRunningConflict(goalId)) {
        this.db.exec("COMMIT");
        return null;
      }
      const candidates = (goalId
        ? this.db.prepare(`SELECT j.id, j.goal_id FROM jobs j JOIN goals g ON g.id=j.goal_id
            WHERE j.status='queued' AND j.goal_id=? AND g.status='active' ORDER BY j.created_at`).all(goalId)
        : this.db.prepare(`SELECT j.id, j.goal_id FROM jobs j LEFT JOIN goals g ON g.id=j.goal_id
            WHERE j.status='queued' AND (j.goal_id IS NULL OR g.status='active') ORDER BY j.created_at`).all()) as { id: string; goal_id: string | null }[];
      // Read conflict roots once while the write transaction holds the claim lock.
      // Re-querying both tables for every queued candidate made a busy queue
      // quadratic in the number of jobs.
      const occupied = this.db.prepare(`SELECT g.project_root FROM jobs j LEFT JOIN goals g ON g.id=j.goal_id
        WHERE j.status IN ('running', 'uncertain')`).all() as { project_root: string | null }[];
      const roots = new Map<string, string | null>();
      const job = candidates.find((candidate) => {
        if (!roots.has(candidate.goal_id ?? "")) {
          roots.set(candidate.goal_id ?? "", candidate.goal_id
            ? this.getGoal(candidate.goal_id).project_root as string | null : null);
        }
        const root = roots.get(candidate.goal_id ?? "");
        return !occupied.some((item) => projectRootsOverlap(root, item.project_root));
      });
      if (!job) {
        this.db.exec("COMMIT");
        return null;
      }
      const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseSeconds * 1000).toISOString();
      this.db.prepare(`
        UPDATE jobs SET status='running', worker=?, attempt_count=attempt_count+1,
          heartbeat_at=?, lease_expires_at=?, stop_requested=0, reservation_released_at=NULL, updated_at=?
        WHERE id=? AND status='queued'
      `).run(worker.trim(), timestamp, leaseExpiresAt, timestamp, job.id);
      this.event(job.id, "claimed", { worker: worker.trim(), leaseSeconds, leaseExpiresAt });
      this.db.exec("COMMIT");
      return this.getJob(job.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(id: string, worker: string, leaseSeconds = 600): Record<string, unknown> {
    if (!worker.trim()) throw new Error("worker is required");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("leaseSeconds must be a positive integer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = this.now();
      let job = this.getJob(id);
      if (job.status === "running" && job.lease_expires_at && String(job.lease_expires_at) <= timestamp) {
        this.expireStaleLocked(timestamp);
        job = this.getJob(id);
      }
      if (job.status !== "running" || job.worker !== worker || Number(job.stop_requested) !== 0) {
        this.db.exec("COMMIT");
        throw new Error("heartbeat rejected for inactive, mismatched, or stopping worker");
      }
      const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseSeconds * 1000).toISOString();
      this.db.prepare("UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=? WHERE id=?")
        .run(timestamp, leaseExpiresAt, timestamp, id);
      this.event(id, "heartbeat", { worker, leaseExpiresAt });
      // Liveness lives on the job row (heartbeat_at). Heartbeats are not copied into goal_events,
      // which progress polling reloads on every wait and would otherwise grow without bound.
      this.db.exec("COMMIT");
      return this.getJob(id);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stopNow(detail: string): string[] {
    const reason = detail.trim();
    if (!reason) throw new Error("stop reason is required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = this.now();
      this.db.prepare("UPDATE settings SET value='true' WHERE key='paused'").run();
      const running = this.db.prepare("SELECT id FROM jobs WHERE status='running'").all() as { id: string }[];
      for (const job of running) {
        this.db.prepare("UPDATE jobs SET stop_requested=1, updated_at=? WHERE id=?").run(timestamp, job.id);
        this.event(job.id, "stop_requested", { reason });
      }
      this.event(null, "stop_now", { reason, jobs: running.map((job) => job.id) });
      this.db.exec("COMMIT");
      return running.map((job) => job.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acknowledgeStopped(id: string, detail: string): void {
    const job = this.getJob(id);
    if (job.status !== "running" || Number(job.stop_requested) !== 1) throw new Error("job has no active stop request");
    const timestamp = this.now();
    this.db.prepare(`
      UPDATE jobs SET status='uncertain', outcome=?, heartbeat_at=NULL,
        lease_expires_at=NULL, stop_requested=0, updated_at=? WHERE id=?
    `).run(detail.trim() || "Worker stopped; reconcile before replacement dispatch.", timestamp, id);
    if (job.goal_id) {
      this.db.prepare("UPDATE goals SET status='uncertain', updated_at=? WHERE id=? AND status!='stopped'").run(timestamp, String(job.goal_id));
      this.goalEvent(String(job.goal_id), "uncertain", { jobId: id, reason: "emergency_stop" });
    }
    this.event(id, "stopped", { detail: detail.trim() });
  }

  stopRequested(id: string, worker: string): boolean {
    const job = this.getJob(id);
    return job.status === "running" && job.worker === worker && Number(job.stop_requested) === 1;
  }

  ask(id: string, question: string): void {
    if (!question.trim()) throw new Error("question is required");
    const job = this.getJob(id);
    if (terminalStatuses.has(job.status as JobStatus)) throw new Error("cannot question a terminal job");
    this.db.prepare("UPDATE jobs SET status='waiting_question', question=?, answer=NULL, heartbeat_at=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
      .run(question.trim(), this.now(), id);
    this.event(id, "question", { question: question.trim() });
  }

  answer(id: string, answer: string): void {
    if (!answer.trim()) throw new Error("answer is required");
    const job = this.getJob(id);
    if (job.status !== "waiting_question") throw new Error("job is not waiting for an answer");
    this.db.prepare("UPDATE jobs SET status='queued', worker=NULL, answer=?, reservation_released_at=NULL, updated_at=? WHERE id=?")
      .run(answer.trim(), this.now(), id);
    this.event(id, "answered", { answer: answer.trim() });
  }

  uncertain(id: string, detail: string, resultArtifactPath?: string): void {
    const job = this.getJob(id);
    if (terminalStatuses.has(job.status as JobStatus)) throw new Error("cannot mark a terminal job uncertain");
    this.db.prepare("UPDATE jobs SET status='uncertain', outcome=?, result_artifact_path=COALESCE(?, result_artifact_path), heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, updated_at=? WHERE id=?")
      .run(detail.trim(), resultArtifactPath ?? null, this.now(), id);
    if (job.goal_id) {
      this.db.prepare("UPDATE goals SET status='uncertain', updated_at=? WHERE id=? AND status!='stopped'").run(this.now(), String(job.goal_id));
      this.goalEvent(String(job.goal_id), "uncertain", { jobId: id, detail: detail.trim(), resultArtifactPath: resultArtifactPath ?? null });
    }
    this.event(id, "uncertain", { detail: detail.trim(), resultArtifactPath: resultArtifactPath ?? null });
  }

  reconcile(id: string, observed: "completed" | "blocked" | "failed" | "queued", detail: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reconcileTransaction(id, observed, detail);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private reconcileTransaction(id: string, observed: "completed" | "blocked" | "failed" | "queued", detail: string): void {
    const job = this.getJob(id);
    if (job.status !== "uncertain") throw new Error("only uncertain jobs can be reconciled");
    const timestamp = this.now();
    const releasedAt = observed === "queued" ? null : timestamp;
    const jobStatus = observed === "blocked" ? "completed" : observed;
    this.db.prepare("UPDATE jobs SET status=?, worker=CASE WHEN ?='queued' THEN NULL ELSE worker END, outcome=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, reservation_released_at=?, updated_at=? WHERE id=?")
      .run(jobStatus, observed, detail.trim(), releasedAt, timestamp, id);
    if (job.goal_id) {
      const goalId = String(job.goal_id);
      if (observed === "completed") {
        // External verification is a valid completion path for an uncertain
        // worker: the preserved workspace and deterministic checks establish
        // the outcome even when the worker receipt is unavailable. Record the
        // evidence and close the goal instead of leaving it blocked for a
        // second, unnecessary model attempt.
        // Reconciliation is an explicit, evidence-backed second action. It may
        // therefore close a goal whose redundant worker was stopped after the
        // origin host had already completed and verified the requested work.
        // The ordinary stop path still remains terminal until this deliberate
        // reconciliation call is made.
        this.db.prepare("UPDATE goals SET status='completed', current_job_id=NULL, last_summary=?, last_evidence=?, next_objective=NULL, question=NULL, updated_at=? WHERE id=?")
          .run(detail.trim(), JSON.stringify([detail.trim()]), timestamp, goalId);
        this.goalEvent(goalId, "iteration_completed_external_verification", {
          jobId: id, iteration: job.goal_iteration, summary: detail.trim(), evidence: [detail.trim()], modelInvokedForReconciliation: false,
        });
      } else {
        const goalStatus: GoalStatus = observed === "queued" ? "active" : "blocked";
        this.db.prepare("UPDATE goals SET status=?, updated_at=? WHERE id=? AND status!='stopped'").run(goalStatus, timestamp, goalId);
        if (observed === "blocked") {
          this.db.prepare("UPDATE goals SET current_job_id=NULL, last_summary=?, last_evidence=?, updated_at=? WHERE id=? AND status!='stopped'")
            .run(detail.trim(), JSON.stringify([detail.trim()]), timestamp, goalId);
          this.goalEvent(goalId, "iteration_completed_external_verification", {
            jobId: id, iteration: job.goal_iteration, summary: detail.trim(), evidence: [detail.trim()], decisionStatus: "blocked", modelInvokedForReconciliation: false,
          });
        } else {
          this.goalEvent(goalId, "reconciled", { jobId: id, observed, goalStatus, detail: detail.trim() });
        }
      }
    }
    this.event(id, "reconciled", { observed, detail: detail.trim() });
  }

  completeExternallyVerifiedGoalIteration(id: string, detail: string, receiptDecisionStatus: GoalDecision["status"] | null = null): Record<string, unknown> {
    const job = this.getJob(id);
    if (!job.goal_id) throw new Error("only a goal job can be externally verified");
    const goalId = String(job.goal_id);
    const goal = this.getGoal(goalId);
    const pausedLatestCompletedIteration = goal.status === "paused"
      && goal.current_job_id === null
      && Number(goal.current_iteration) === Number(job.goal_iteration);
    const stoppedLatestIteration = goal.status === "stopped"
      && Number(goal.current_iteration) === Number(job.goal_iteration)
      && (goal.current_job_id === null || String(goal.current_job_id) === id);
    if (!['completed', 'failed'].includes(String(job.status))
      && !(stoppedLatestIteration && job.status === "uncertain")) {
      throw new Error("only a completed or failed goal job, or the latest stopped uncertain job, can be externally verified");
    }
    if (!['blocked', 'uncertain'].includes(String(goal.status)) && !pausedLatestCompletedIteration && !stoppedLatestIteration) {
      throw new Error("goal is not awaiting external verification");
    }
    const evidence = detail.trim();
    if (!evidence) throw new Error("external verification evidence is required");
    const timestamp = this.now();
    this.db.prepare("UPDATE jobs SET status='completed', outcome=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, reservation_released_at=COALESCE(reservation_released_at, ?), updated_at=? WHERE id=?")
      .run(evidence, timestamp, timestamp, id);
    this.db.prepare("UPDATE goals SET status='completed', current_job_id=NULL, last_summary=?, last_evidence=?, next_objective=NULL, question=NULL, updated_at=? WHERE id=?")
      .run(evidence, JSON.stringify([evidence]), timestamp, goalId);
    this.goalEvent(goalId, "iteration_completed_external_verification", {
      jobId: id, iteration: job.goal_iteration, summary: evidence, evidence: [evidence], modelInvokedForReconciliation: false,
      receiptDecisionStatus,
    });
    return this.getGoal(goalId);
  }

  finish(id: string, status: "completed" | "failed", outcome: string, resultArtifactPath?: string): void {
    const job = this.getJob(id);
    if (terminalStatuses.has(job.status as JobStatus)) throw new Error("job is already terminal");
    const timestamp = this.now();
    this.db.prepare("UPDATE jobs SET status=?, outcome=?, result_artifact_path=?, heartbeat_at=NULL, lease_expires_at=NULL, stop_requested=0, reservation_released_at=?, updated_at=? WHERE id=?")
      .run(status, outcome.trim(), resultArtifactPath ?? null, timestamp, timestamp, id);
    const usageLimit = job.goal_id && status === "failed" ? detectUsageLimit(outcome, this.clock()) : null;
    if (job.goal_id && usageLimit && this.pauseForUsageLimit(String(job.goal_id), id, usageLimit)) {
      this.event(id, status, { outcome: outcome.trim(), resultArtifactPath: resultArtifactPath ?? null, usageLimited: true });
      return;
    }
    if (job.goal_id && status === "failed") {
      this.db.prepare("UPDATE goals SET status='blocked', updated_at=? WHERE id=? AND status NOT IN ('stopped','uncertain')").run(timestamp, String(job.goal_id));
      this.goalEvent(String(job.goal_id), "blocked", { jobId: id, reason: outcome.trim() });
    }
    this.event(id, status, { outcome: outcome.trim(), resultArtifactPath: resultArtifactPath ?? null });
  }

  /** The provider a job was routed to, and the providers installed when it was routed. */
  private jobRoute(jobId: string): { provider: string | null; installedProviders: string[] } {
    const note = this.events(jobId).filter((event) => event.kind === "route_selected").at(-1);
    try {
      const route = JSON.parse(JSON.parse(String(note?.detail)).detail);
      return { provider: typeof route.provider === "string" ? route.provider : null,
        installedProviders: Array.isArray(route.installedProviders) ? route.installedProviders.map(String) : [] };
    } catch { return { provider: null, installedProviders: [] }; }
  }

  /** Providers whose usage window is exhausted right now, from recent usage-limit events on any goal. */
  providersAtUsageLimit(): string[] {
    const now = this.clock().getTime();
    const rows = this.db.prepare("SELECT detail FROM goal_events WHERE kind IN ('usage_limit_paused','usage_limit_switched') ORDER BY sequence DESC LIMIT 200")
      .all() as Array<{ detail: string }>;
    const limited = new Set<string>();
    for (const row of rows) {
      try {
        const detail = JSON.parse(row.detail);
        if (detail.provider && detail.resumeAt && Date.parse(detail.resumeAt) > now) limited.add(String(detail.provider));
      } catch { /* an unreadable event names no provider */ }
    }
    return [...limited];
  }

  /**
   * A provider usage limit is not a failure of the work. The same step is queued
   * again; when another installed provider is free, the goal keeps running and
   * routing skips the limited provider until its reset time. Otherwise the goal
   * pauses and resumes at the stated reset time (or after a short wait). It does
   * not count toward progress limits.
   */
  private pauseForUsageLimit(goalId: string, jobId: string, limit: UsageLimit): boolean {
    const goal = this.getGoal(goalId);
    if (!["active", "paused"].includes(String(goal.status)) || String(goal.current_job_id) !== jobId) return false;
    const job = this.getJob(jobId);
    const resumeAt = limit.resetsAt && Date.parse(limit.resetsAt) > this.clock().getTime()
      ? limit.resetsAt : new Date(this.clock().getTime() + DEFAULT_USAGE_LIMIT_WAIT_MS).toISOString();
    const route = this.jobRoute(jobId);
    const limited = new Set([...this.providersAtUsageLimit(), ...(route.provider ? [route.provider] : [])]);
    const switchTo = route.provider && goal.status === "active"
      ? route.installedProviders.find((provider) => !limited.has(provider)) ?? null : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replacement = this.enqueueGoalIterationLocked(goalId, String(goal.next_objective ?? goal.objective), goal.answer as string | null,
        Number(job.package_stage_iteration ?? job.goal_iteration));
      const timestamp = this.now();
      if (switchTo) {
        this.goalEvent(goalId, "usage_limit_switched", { jobId, replacementJobId: replacement!.id, provider: route.provider, switchTo, resumeAt, matched: limit.matched });
      } else {
        this.db.prepare("UPDATE goals SET status='paused', updated_at=? WHERE id=?").run(timestamp, goalId);
        this.db.prepare("UPDATE jobs SET reservation_released_at=?, updated_at=? WHERE id=? AND status='queued'")
          .run(timestamp, timestamp, String(replacement!.id));
        this.goalEvent(goalId, "usage_limit_paused", { jobId, replacementJobId: replacement!.id, provider: route.provider, resumeAt, matched: limit.matched });
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** The time a usage-limited goal may resume, or null when it is not waiting on a provider limit. */
  usageLimitResumeAt(goalId: string): string | null {
    const goal = this.getGoal(goalId);
    if (goal.status !== "paused") return null;
    const latest = this.goalEvents(goalId).filter((event) => ["usage_limit_paused", "paused", "resumed", "usage_limit_resumed"].includes(String(event.kind))).at(-1);
    if (latest?.kind !== "usage_limit_paused") return null;
    try { return String(JSON.parse(String(latest.detail)).resumeAt); } catch { return null; }
  }

  /** Resume a goal whose provider usage window has reset; returns true when it was resumed. */
  resumeAfterUsageLimit(goalId: string): boolean {
    const resumeAt = this.usageLimitResumeAt(goalId);
    if (!resumeAt || Date.parse(resumeAt) > this.clock().getTime()) return false;
    this.resumeGoal(goalId);
    this.goalEvent(goalId, "usage_limit_resumed", { resumeAt });
    return true;
  }
}

// Compare real paths so a symlinked install location (macOS /var, /tmp) still starts.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void import("./coordinator-cli.ts").then(({ main }) => main());
}
