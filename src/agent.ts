export function isAgentCaller(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.SESSIONREADER_AGENT === 'true' ||
    process.env.CI === 'true'
  );
}
