/**
 * State Machine — Canonical state transitions for Smart Upload workflows.
 *
 * This module defines the allowed transitions for every status dimension
 * in the SmartUploadSession lifecycle. No worker or route should write
 * a status string directly — they must go through the helpers here.
 */

import type { ParseStatus, SecondPassStatus } from "../../types/smart-upload";

// =============================================================================
// Status Enums (canonical values stored in DB)
// =============================================================================

/**
 * Top-level workflow status — aligned 1:1 with the Prisma SmartUploadStatus
 * enum.  Do NOT add values here that are not also in the DB enum.
 *
 * Active states:
 *   PROCESSING       – worker is parsing / classifying
 *   AUTO_COMMITTING  – passed quality gates, queued for autonomous commit
 *
 * Terminal / resolution states:
 *   AUTO_COMMITTED    – committed by the autonomous pipeline
 *   REQUIRES_REVIEW   – needs human review (exception path)
 *   MANUALLY_APPROVED – human approved & committed to library
 *   REJECTED          – human rejected
 *   FAILED            – unrecoverable failure
 *
 * Legacy values kept for backward-compat (no new sessions should use these):
 *   PENDING_REVIEW   → maps to REQUIRES_REVIEW
 *   APPROVED         → maps to MANUALLY_APPROVED
 */
export type WorkflowStatus =
  | "PROCESSING"
  | "AUTO_COMMITTING"
  | "AUTO_COMMITTED"
  | "REQUIRES_REVIEW"
  | "MANUALLY_APPROVED"
  | "REJECTED"
  | "FAILED"
  // legacy — avoid using in new code
  | "PENDING_REVIEW"
  | "APPROVED";

/**
 * OCR sub-status.
 */
export type OcrStatus =
  | "NOT_NEEDED"
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED";

/**
 * Commit sub-status.
 */
export type CommitStatus =
  | "NOT_STARTED"
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED";

// =============================================================================
// Review visibility constants
// =============================================================================

/**
 * Statuses that should be visible from the Music Review admin surface by default.
 * A Smart Upload session must never become invisible just because it is still
 * processing, waiting on a second pass, failed, or auto-committing.
 */
export const REVIEW_ACTIONABLE_WORKFLOW_STATUSES = [
  "PROCESSING",
  "AUTO_COMMITTING",
  "REQUIRES_REVIEW",
  "FAILED",
  "PENDING_REVIEW",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_NEEDS_REVIEW_WORKFLOW_STATUSES = [
  "REQUIRES_REVIEW",
  "PENDING_REVIEW",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_PROCESSING_WORKFLOW_STATUSES = [
  "PROCESSING",
  "AUTO_COMMITTING",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_APPROVED_WORKFLOW_STATUSES = [
  "AUTO_COMMITTED",
  "MANUALLY_APPROVED",
  "APPROVED",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_REJECTED_WORKFLOW_STATUSES = [
  "REJECTED",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_FAILED_WORKFLOW_STATUSES = [
  "FAILED",
] as const satisfies readonly WorkflowStatus[];

export const REVIEW_ALL_WORKFLOW_STATUSES = [
  ...REVIEW_ACTIONABLE_WORKFLOW_STATUSES,
  ...REVIEW_APPROVED_WORKFLOW_STATUSES,
  ...REVIEW_REJECTED_WORKFLOW_STATUSES,
] as const satisfies readonly WorkflowStatus[];

export type SmartUploadReviewFilter =
  | "ACTIONABLE"
  | "NEEDS_REVIEW"
  | "PROCESSING"
  | "FAILED"
  | "APPROVED"
  | "REJECTED"
  | "ALL"
  | WorkflowStatus;

export function normalizeWorkflowStatus(
  status: string | null | undefined,
): WorkflowStatus | null {
  switch (status) {
    case "PROCESSING":
    case "AUTO_COMMITTING":
    case "AUTO_COMMITTED":
    case "REQUIRES_REVIEW":
    case "MANUALLY_APPROVED":
    case "REJECTED":
    case "FAILED":
    case "PENDING_REVIEW":
    case "APPROVED":
      return status;
    default:
      return null;
  }
}

export function getReviewStatusesForFilter(
  filter: SmartUploadReviewFilter | string | null | undefined,
): readonly WorkflowStatus[] {
  const normalized = (filter || "ACTIONABLE").toString().toUpperCase();

  switch (normalized) {
    case "ACTIONABLE":
      return REVIEW_ACTIONABLE_WORKFLOW_STATUSES;
    case "NEEDS_REVIEW":
      return REVIEW_NEEDS_REVIEW_WORKFLOW_STATUSES;
    case "PROCESSING":
      return REVIEW_PROCESSING_WORKFLOW_STATUSES;
    case "FAILED":
      return REVIEW_FAILED_WORKFLOW_STATUSES;
    case "APPROVED":
      return REVIEW_APPROVED_WORKFLOW_STATUSES;
    case "REJECTED":
      return REVIEW_REJECTED_WORKFLOW_STATUSES;
    case "ALL":
      return REVIEW_ALL_WORKFLOW_STATUSES;
    default: {
      const status = normalizeWorkflowStatus(normalized);
      return status ? [status] : REVIEW_ACTIONABLE_WORKFLOW_STATUSES;
    }
  }
}

export function isReviewActionableWorkflowStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeWorkflowStatus(status);
  return normalized
    ? (REVIEW_ACTIONABLE_WORKFLOW_STATUSES as readonly WorkflowStatus[]).includes(normalized)
    : false;
}

export function isReviewApprovableWorkflowStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeWorkflowStatus(status);
  return normalized
    ? (REVIEW_NEEDS_REVIEW_WORKFLOW_STATUSES as readonly WorkflowStatus[]).includes(normalized)
    : false;
}

// =============================================================================
// Transition Maps
// =============================================================================

/**
 * Allowed next states for each WorkflowStatus.
 */
const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> =
  {
    // Active states
    PROCESSING: ["AUTO_COMMITTING", "REQUIRES_REVIEW", "FAILED"],
    AUTO_COMMITTING: ["AUTO_COMMITTED", "REQUIRES_REVIEW", "FAILED"],
    // Terminal / resolution states
    AUTO_COMMITTED: [], // terminal
    REQUIRES_REVIEW: ["MANUALLY_APPROVED", "REJECTED", "FAILED"],
    MANUALLY_APPROVED: [], // terminal
    REJECTED: [], // terminal
    FAILED: ["PROCESSING"], // allow retry from FAILED
    // Legacy values
    PENDING_REVIEW: [
      "MANUALLY_APPROVED",
      "REJECTED",
      "REQUIRES_REVIEW",
      "FAILED",
    ],
    APPROVED: [], // terminal (legacy)
  };

/**
 * Allowed next states for ParseStatus.
 */
const PARSE_TRANSITIONS: Record<ParseStatus, readonly ParseStatus[]> = {
  NOT_PARSED: ["PARSING"],
  PARSING: ["PARSED", "PARSE_FAILED"],
  PARSED: [], // terminal success
  PARSE_FAILED: ["PARSING"], // retry
};

/**
 * Allowed next states for SecondPassStatus.
 */
const SECOND_PASS_TRANSITIONS: Record<
  SecondPassStatus,
  readonly SecondPassStatus[]
> = {
  NOT_NEEDED: ["QUEUED"],
  QUEUED: ["IN_PROGRESS", "FAILED"],
  IN_PROGRESS: ["COMPLETE", "FAILED"],
  COMPLETE: [], // terminal
  FAILED: ["QUEUED"], // retry
};

/**
 * Allowed next states for OcrStatus.
 */
const OCR_TRANSITIONS: Record<OcrStatus, readonly OcrStatus[]> = {
  NOT_NEEDED: ["QUEUED"],
  QUEUED: ["IN_PROGRESS", "FAILED"],
  IN_PROGRESS: ["COMPLETE", "FAILED"],
  COMPLETE: [], // terminal
  FAILED: ["QUEUED"], // retry
};

/**
 * Allowed next states for CommitStatus.
 */
const COMMIT_TRANSITIONS: Record<CommitStatus, readonly CommitStatus[]> = {
  NOT_STARTED: ["QUEUED"],
  QUEUED: ["IN_PROGRESS", "FAILED"],
  IN_PROGRESS: ["COMPLETE", "FAILED"],
  COMPLETE: [], // terminal
  FAILED: ["QUEUED"], // retry
};

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Check whether a status transition is allowed.
 */
export function isValidTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): boolean {
  const allowed = transitions[from];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(to);
}

/**
 * Assert a transition is valid, throwing if not.
 */
export function assertTransition<T extends string>(
  dimensionName: string,
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): void {
  if (!isValidTransition(transitions, from, to)) {
    throw new Error(
      `Invalid ${dimensionName} transition: ${from} → ${to}. ` +
        `Allowed: [${(transitions[from] ?? []).join(", ")}]`,
    );
  }
}

// -- Workflow --

export function isValidWorkflowTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return isValidTransition(WORKFLOW_TRANSITIONS, from, to);
}

export function assertWorkflowTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): void {
  assertTransition("workflow", WORKFLOW_TRANSITIONS, from, to);
}

// -- Parse --

export function isValidParseTransition(
  from: ParseStatus,
  to: ParseStatus,
): boolean {
  return isValidTransition(PARSE_TRANSITIONS, from, to);
}

export function assertParseTransition(
  from: ParseStatus,
  to: ParseStatus,
): void {
  assertTransition("parseStatus", PARSE_TRANSITIONS, from, to);
}

// -- Second Pass --

export function isValidSecondPassTransition(
  from: SecondPassStatus,
  to: SecondPassStatus,
): boolean {
  return isValidTransition(SECOND_PASS_TRANSITIONS, from, to);
}

export function assertSecondPassTransition(
  from: SecondPassStatus,
  to: SecondPassStatus,
): void {
  assertTransition("secondPassStatus", SECOND_PASS_TRANSITIONS, from, to);
}

// -- OCR --

export function isValidOcrTransition(from: OcrStatus, to: OcrStatus): boolean {
  return isValidTransition(OCR_TRANSITIONS, from, to);
}

export function assertOcrTransition(from: OcrStatus, to: OcrStatus): void {
  assertTransition("ocrStatus", OCR_TRANSITIONS, from, to);
}

// -- Commit --

export function isValidCommitTransition(
  from: CommitStatus,
  to: CommitStatus,
): boolean {
  return isValidTransition(COMMIT_TRANSITIONS, from, to);
}

export function assertCommitTransition(
  from: CommitStatus,
  to: CommitStatus,
): void {
  assertTransition("commitStatus", COMMIT_TRANSITIONS, from, to);
}

// =============================================================================
// Decision Helpers
// =============================================================================

/**
 * Whether a session can have OCR queued.
 */
export function canQueueOcr(ocrStatus: OcrStatus): boolean {
  return ocrStatus === "NOT_NEEDED" || ocrStatus === "FAILED";
}

/**
 * Whether a session can have a second pass queued.
 */
export function canQueueSecondPass(
  secondPassStatus: SecondPassStatus,
): boolean {
  return secondPassStatus === "NOT_NEEDED" || secondPassStatus === "FAILED";
}

/**
 * Whether a session can be auto-committed.
 */
export function canAutoCommit(
  workflowStatus: WorkflowStatus,
  commitStatus: CommitStatus,
  secondPassStatus: SecondPassStatus,
  autoApproved: boolean,
): boolean {
  // Must be in a processing-complete state ready for autonomous commit
  const eligibleWorkflow =
    workflowStatus === "PROCESSING" || workflowStatus === "AUTO_COMMITTING";
  // Must not already be committed or in progress
  const eligibleCommit =
    commitStatus === "NOT_STARTED" || commitStatus === "FAILED";
  // Second pass must be complete or not needed
  const secondPassDone =
    secondPassStatus === "COMPLETE" || secondPassStatus === "NOT_NEEDED";
  // Must be auto-approved
  return eligibleWorkflow && eligibleCommit && secondPassDone && autoApproved;
}

/**
 * Whether a session should enter manual review (exception path).
 */
export function canEnterReview(
  workflowStatus: WorkflowStatus,
  requiresHumanReview: boolean,
): boolean {
  const eligible =
    workflowStatus === "PROCESSING" || workflowStatus === "AUTO_COMMITTING";
  return eligible && requiresHumanReview;
}

/**
 * Whether a commit can be retried.
 */
export function canRetryCommit(commitStatus: CommitStatus): boolean {
  return commitStatus === "FAILED";
}

/**
 * Whether a workflow is in a terminal state.
 */
export function isTerminalWorkflow(status: WorkflowStatus): boolean {
  return (
    status === "AUTO_COMMITTED" ||
    status === "MANUALLY_APPROVED" ||
    status === "REJECTED" ||
    status === "FAILED" ||
    // legacy
    status === "APPROVED"
  );
}

/**
 * Whether a workflow is in a failed state (retriable terminal).
 */
export function isFailedWorkflow(status: WorkflowStatus): boolean {
  return status === "FAILED";
}
