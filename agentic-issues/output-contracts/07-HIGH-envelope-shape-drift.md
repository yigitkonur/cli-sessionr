# 07 · HIGH · Envelope shape drifts across commands — no unified `{ok,data,meta,error,actions}` contract

**Context:** output-contracts · **Severity:** High · **Status:** open
**Owners:** every command emitter

## Evidence

| Command | Top-level shape | Notes |
|---|---|---|
| `list` | `{api_version, sessions[], total_available, limit, offset, has_more, available_sources, cursor, actions}` | sessions at root |
| `read` | `{api_version, session?, meta, messages[], actions}` | session under nested key |
| `info` | `{api_version, id, source, cwd, model, …flat session fields…, actions}` | flat — no wrapper |
| `stats` | `{api_version, …spread of NormalizedSession…, actions}` | flat — no wrapper |
| `send sync` | `{api_version, meta, messages[], actions}` | uses `meta` |
| `send async` | `{api_version, data:{job_id,session_id,…}, actions}` | uses `data` |
| `job` / `wait` / `cancel` | `{api_version, data, actions}` | uses `data` |
| `jobs` (list) | `{api_version, jobs[], total}` | jobs at root |
| `prune --dry-run` | `{api_version, dry_run, would_delete[], count}` | none of the above |
| `prune --yes` | `{api_version, status, deleted[], count}` | new shape |
| `tag` | `{api_version, status, tags[]}` | new shape |
| `context` | depends on `--format` flag | inconsistent both ways |

There is no `ok` boolean and no `schema_version` (only `api_version`, which is a number repurposed as both API and schema version). Errors use `{error:{…}}` with no `ok:false` sibling.

## Why this fails an agent

Agents writing one parser for the whole CLI must hand-roll a switch-on-command. That defeats the purpose of giving them JSON in the first place. The skill's recommended envelope is:

```json
{ "ok": true, "schema_version": "v1", "result": {...}, "meta": {...}, "actions": [...] }
{ "ok": false, "schema_version": "v1", "error": {"class","code","message","detail","suggestion","retryable"} }
```

Adopting one shape lets agents code `if (!resp.ok) handle(resp.error); else use(resp.result)` once and forget it.

## Fix

Adopt the recommended envelope. Migrate command-by-command (each command can wrap its existing payload under `result`) and bump `schema_version` to `"v2"` while keeping `api_version: 1` available for one release as a deprecation alias.

Suggested mapping:

| Old | New |
|---|---|
| `{sessions: [...]}` (list) | `{ok:true, schema_version:"v2", result:{sessions:[...]}, meta:{cursor, has_more, …}}` |
| `{messages: [...], session, meta}` (read) | `{ok:true, …, result:{session, messages:[...]}, meta}` |
| flat info/stats | `{ok:true, …, result:{session:{…}}}` |
| `{data:{…}}` (send/job) | `{ok:true, …, result:{…}}` (drop `data`) |
| `{jobs:[...]}` | `{ok:true, …, result:{jobs:[...]}}` |
| any error | `{ok:false, …, error:{class, code, message, detail, suggestion, retryable}}` |

Document the transition in a `MIGRATION.md` and gate on `--api-version 2` (which is currently dead — see [[output-contracts/15-LOW-api-version-flag-is-dead]]).

## Verification

```bash
for c in 'list' 'read <id>' 'info <id>' 'stats <id>' 'send <id> -m hi' 'jobs'; do
  sessionr --api-version 2 --output json $c | jq 'has("ok") and has("result") and has("schema_version")'
done
# expect all true
```

## Related

- [[output-contracts/08-HIGH-no-ok-and-schema-version-fields]]
- [[output-contracts/09-HIGH-error-envelope-shape-inconsistency]]
- [[output-contracts/15-LOW-api-version-flag-is-dead]]
