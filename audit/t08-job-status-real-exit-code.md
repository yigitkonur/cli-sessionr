# T08 Job Status Real Exit Code

## Changes

- Async jobs now spawn through a `bash -c` wrapper that executes the selected tool and writes the real child exit code to `<job>.json.exit`.
- `finalizeJob` reads the sidecar exit code and no longer infers failure from stderr content.
- Missing or invalid exit sidecars finalize dead jobs as `failed` with `exit_code: -1` and `last_error: "exit_code_missing"`.
- Job persistence now writes through `<job>.json.tmp` followed by `renameSync`, guarded by a minimal per-job `.lock` file.
- `finalizeJob` and `cancelJob` return fresh `Job` objects instead of mutating their input.
- Cancelled jobs now use `status: "cancelled"` with `exit_code: 130`.
- Successful async dispatch explicitly sets `process.exitCode = 0`.

## Verification

- `pnpm build`
- `pnpm test`
- Focused async checks:
  - stderr warning with exit 0 finalizes as `completed`.
  - silent `exit 137` finalizes as `failed` with `exit_code: 137`.
  - cancelled running jobs report `cancelled`.
