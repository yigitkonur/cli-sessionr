# 02 · HIGH · Three `send` validation errors emit raw plain-text on stderr (no JSON)

**Context:** errors · **Severity:** High · **Status:** open
**Owners:** `src/cli.ts:243-262`

This is the errors/contract slice of the same problem covered in [[output-contracts/05-CRITICAL-send-validation-bypasses-formatter]]. Read that file for the proposed fix.

Probes that prove the bug:
- `_probes/15_send_no_args.err` — plain text `Error: Either --message or --file is required`.
- `_probes/16_send_no_args_json.err` — `--output json` ignored.
- `_probes/64_send_both_msg_file.err` — plain text on stderr.

The error-shape consequence is that an agent's JSON parser sees an empty stdout and a non-JSON stderr. Without the fix in [[output-contracts/05-CRITICAL-send-validation-bypasses-formatter]], no agent that pipes `send` can recover automatically.
