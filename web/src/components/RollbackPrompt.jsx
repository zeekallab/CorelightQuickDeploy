// Shown only when a deploy FAILS after Azure resources were created. Offers a one-click
// rollback (terraform destroy) so half-built infrastructure doesn't sit there costing money.
import React from "react";

export default function RollbackPrompt({ rollback, onRollback, onDismiss }) {
  if (rollback.done) {
    return (
      <div className="card rollback-card ok">
        <h2>Rolled back</h2>
        <p className="muted small">The resources this run created were deleted. Your resource group was left untouched.</p>
      </div>
    );
  }

  return (
    <div className="card rollback-card">
      <h2>Deployment failed</h2>
      <p className="small">
        Some Azure resources may have been created before the failure — they’ll keep costing money until removed.
        Roll back to delete <strong>everything this run created</strong>? Your resource group itself is left untouched.
      </p>
      {rollback.error && <p className="warn small">⚠ {rollback.error}</p>}
      <div className="grid2">
        <button className="btn" type="button" disabled={rollback.running} onClick={onDismiss}>
          Keep resources
        </button>
        <button className="btn danger" type="button" disabled={rollback.running} onClick={onRollback}>
          {rollback.running ? "Rolling back…" : rollback.error ? "Retry rollback" : "Delete created resources"}
        </button>
      </div>
    </div>
  );
}
