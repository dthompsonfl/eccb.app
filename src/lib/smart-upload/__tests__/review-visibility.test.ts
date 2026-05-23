import { describe, expect, it } from "vitest";
import {
  getReviewStatusesForFilter,
  isReviewActionableWorkflowStatus,
  isReviewApprovableWorkflowStatus,
} from "../state";

describe("Smart Upload review visibility", () => {
  it("shows processing, failed, and review-needed sessions in the default actionable view", () => {
    expect(getReviewStatusesForFilter(undefined)).toEqual([
      "PROCESSING",
      "AUTO_COMMITTING",
      "REQUIRES_REVIEW",
      "FAILED",
      "PENDING_REVIEW",
    ]);
  });

  it("keeps uploaded sessions visible even when they fail before review", () => {
    expect(isReviewActionableWorkflowStatus("FAILED")).toBe(true);
    expect(isReviewActionableWorkflowStatus("PROCESSING")).toBe(true);
    expect(isReviewActionableWorkflowStatus("AUTO_COMMITTING")).toBe(true);
  });

  it("restricts bulk approval to review-ready states only", () => {
    expect(isReviewApprovableWorkflowStatus("REQUIRES_REVIEW")).toBe(true);
    expect(isReviewApprovableWorkflowStatus("PENDING_REVIEW")).toBe(true);
    expect(isReviewApprovableWorkflowStatus("PROCESSING")).toBe(false);
    expect(isReviewApprovableWorkflowStatus("FAILED")).toBe(false);
    expect(isReviewApprovableWorkflowStatus("AUTO_COMMITTED")).toBe(false);
  });

  it("supports explicit grouped filters for queue tabs", () => {
    expect(getReviewStatusesForFilter("PROCESSING")).toEqual([
      "PROCESSING",
      "AUTO_COMMITTING",
    ]);
    expect(getReviewStatusesForFilter("NEEDS_REVIEW")).toEqual([
      "REQUIRES_REVIEW",
      "PENDING_REVIEW",
    ]);
    expect(getReviewStatusesForFilter("FAILED")).toEqual(["FAILED"]);
  });
});
