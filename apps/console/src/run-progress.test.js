import { describe, it, expect } from "vitest";
import { purchaseProgress } from "./run-progress";
const task = {
  id: "task-a",
  intent_id: "order-a",
  task: { items: [{ title: "template" }] },
};
const hash = "0x" + "a".repeat(64);
const progress = (state, extra = {}, audit = []) =>
  purchaseProgress(
    { mandate_id: task.id, result: { text: "支払済みです" } },
    [task],
    [{ id: task.intent_id, state, ...extra }],
    audit,
  );
describe("payment progress comes from authenticated records", () => {
  it("does not treat model prose or a submitted hash as settlement", () => {
    expect(progress("submitted", { transaction_hash: hash }).paid).toBe(false);
    expect(progress("authorized").steps.at(-1).status).toBe("waiting");
    expect(progress("confirmed").paid).toBe(false);
  });
  it("requires a confirmed payment and its actual hash", () => {
    expect(progress("confirmed", { transaction_hash: hash }).paid).toBe(true);
  });
  it("shows a budget exception without claiming conditions passed", () => {
    const p = progress("approval_required");
    expect(p.attention).toBe(true);
    expect(p.steps[2].status).toBe("attention");
    expect(p.steps[3].status).toBe("waiting");
  });
  it("does not borrow progress from another purchase or account", () => {
    expect(purchaseProgress({ mandate_id: "other" }, [task], [])).toBeNull();
    expect(
      progress("confirmed", { transaction_hash: hash }, [
        { action: "order.digital_access_granted", data: { intentId: "other" } },
      ]).received,
    ).toBe(false);
  });
  it("keeps failed and canceled payments separate from success", () => {
    for (const state of ["failed", "canceled"]) {
      expect(progress(state, { transaction_hash: hash }).stopped).toBe(true);
      expect(progress(state, { transaction_hash: hash }).paid).toBe(false);
    }
  });
  it("shows the settled amount rather than the task's spending ceiling", () => {
    expect(
      progress("confirmed", { amount_minor: 300, transaction_hash: hash })
        .amount,
    ).toBe(300);
  });
  it("does not keep claiming execution after a run ends without a checkout", () => {
    const p = purchaseProgress(
      { mandate_id: task.id, status: "completed" },
      [task],
      [],
    );
    expect(p.needsCheck).toBe(true);
    expect(p.steps[1].status).toBe("attention");
  });
  it("does not match unrelated audit records before an intent exists", () => {
    const p = purchaseProgress(
      { mandate_id: task.id, status: "running" },
      [{ ...task, intent_id: undefined }],
      [],
      [
        { action: "purchase.authorized", resource_id: "previous-purchase" },
        {
          action: "order.digital_access_granted",
          resource_id: "previous-order",
        },
      ],
    );
    expect(p.steps[2].status).toBe("waiting");
    expect(p.received).toBe(false);
  });
  it("treats a failed runner as unknown, not proof that no payment happened", () => {
    const p = purchaseProgress(
      { mandate_id: task.id, status: "failed" },
      [task],
      [],
    );
    expect(p.paid).toBe(false);
    expect(p.stopped).toBe(false);
    expect(p.needsCheck).toBe(true);
  });
});
