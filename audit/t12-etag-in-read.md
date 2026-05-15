# t12 etag in read audit

- Moved --if-changed handling into readCommand after the single loadSession call.
- read JSON responses now include meta.etag.
- read JSONL responses now include etag on the meta line.
- Unchanged responses emit a small JSON body and preserve exit code 42.
- ETags include updatedAt, totalMessages, preset, token budget, range, anchor, search, page, and output format.

Verified:

- pnpm build
- pnpm test
- Built CLI etag emission, unchanged exit 42 body, token-budget etag variance, JSONL meta etag, and SESSION_NOT_FOUND routing.
