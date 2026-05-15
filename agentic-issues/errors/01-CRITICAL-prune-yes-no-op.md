# 01 · CRITICAL · `prune --yes` returns `status:"ok"` without deleting

See [[destructive/01-CRITICAL-prune-yes-fakes-deletion]] for the full write-up. This file mirrors it under the errors/exit-codes lens — the relevant error-shape consequence is that the success envelope misrepresents reality, which is a worse failure mode than any error envelope could be.

**Severity:** Critical · **Status:** open · **Quick fix:** refuse with `{ok:false, error:{class:"internal", code:"NOT_IMPLEMENTED", retryable:false}}` until real deletion is wired.
