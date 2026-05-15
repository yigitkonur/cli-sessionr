let _isNpx: boolean | null = null;

/** True when sessionr was invoked via `npx` / `npm exec`. */
export function isNpxInvocation(): boolean {
  if (_isNpx !== null) return _isNpx;
  _isNpx =
    process.env['npm_command'] === 'exec' ||
    (process.argv[1]?.includes('/_npx/') ?? false);
  return _isNpx;
}

/** "npx sessionr" when invoked via npx, otherwise "sessionr". */
export function cmdPrefix(): string {
  return isNpxInvocation() ? 'npx sessionr' : 'sessionr';
}
