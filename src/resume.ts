import type { SessionSource } from './types.js';

export interface ResumeHint {
  interactive: string;
  nonInteractive: string;
  description: string;
  verified: boolean;
}

// Verified: resume syntax confirmed from actual --help output on this machine.
// Unverified: best-effort from GitHub source / official docs, not tested locally.

const RESUME_TEMPLATES: Record<SessionSource, (id: string) => ResumeHint> = {
  // VERIFIED: claude --help shows -r/--resume [value], -p for print mode
  claude: (id) => ({
    interactive: `claude -r ${id}`,
    nonInteractive: `claude -p -r ${id} "your follow-up prompt"`,
    description: 'Continue this Claude Code session',
    verified: true,
  }),

  // VERIFIED: codex resume --help, codex exec resume --help
  codex: (id) => ({
    interactive: `codex resume ${id}`,
    nonInteractive: `codex exec resume ${id} "your follow-up prompt"`,
    description: 'Continue this Codex session',
    verified: true,
  }),

  // VERIFIED: gemini --help shows -r/--resume <string>, -p for headless
  // Note: gemini uses session index or "latest", not UUID. Passing the UUID
  // from sessionreader may not work directly — user may need --list-sessions first.
  gemini: (id) => ({
    interactive: `gemini -r "${id}"`,
    nonInteractive: `gemini -p "your follow-up prompt" -r "${id}"`,
    description: 'Continue this Gemini CLI session (may need session index from --list-sessions)',
    verified: true,
  }),

  // VERIFIED: binary is `agent` (symlink to cursor-agent). Has -p print mode.
  'cursor-agent': (id) => ({
    interactive: `agent --resume ${id}`,
    nonInteractive: `agent -p --resume ${id} "your follow-up prompt"`,
    description: 'Continue this Cursor Agent session',
    verified: true,
  }),

  // VERIFIED: copilot --help shows --resume[=sessionId], --continue, -p for print
  copilot: (id) => ({
    interactive: `copilot --resume=${id}`,
    nonInteractive: `copilot -p "your follow-up prompt" --resume=${id}`,
    description: 'Continue this Copilot session',
    verified: true,
  }),

  // VERIFIED: opencode --help shows -s/--session <string>, -c/--continue
  // Also has headless mode via `opencode run`. Project archived, now Crush.
  opencode: (id) => ({
    interactive: `opencode -s ${id}`,
    nonInteractive: `opencode run -s ${id} "your follow-up prompt"`,
    description: 'Continue this OpenCode session (project archived, now Crush)',
    verified: true,
  }),

  // UNVERIFIED: from commandcode.ai/docs/reference/cli
  // Binary is `cmd`. --resume accepts session ID or opens picker without one.
  commandcode: (id) => ({
    interactive: `cmd --resume ${id}`,
    nonInteractive: `cmd -p "your follow-up prompt" --resume ${id}`,
    description: 'Continue this CommandCode session',
    verified: false,
  }),

  // UNVERIFIED: from github.com/block/goose crates/goose-cli/src/cli.rs
  // Supports --session-id <id> or -n <name> with --resume flag.
  goose: (id) => ({
    interactive: `goose session --resume --session-id ${id}`,
    nonInteractive: `goose run --resume --session-id ${id} -t "your follow-up prompt"`,
    description: 'Continue this Goose session',
    verified: false,
  }),

  // UNVERIFIED: from kiro.dev/docs/cli/reference/cli-commands/
  // --resume resumes most recent session in current dir. Cannot target by ID.
  // --resume-picker opens interactive selection.
  kiro: (_id) => ({
    interactive: `kiro-cli chat --resume-picker`,
    nonInteractive: `kiro-cli chat --no-interactive --resume`,
    description: 'Continue this Kiro session (--resume = most recent in cwd, --resume-picker to choose)',
    verified: false,
  }),

  // UNVERIFIED: Zed AI threads are GUI-only (Agent Panel).
  // No CLI resume command exists. The `zed` binary only opens files/projects.
  zed: (_id) => ({
    interactive: `# No CLI resume — open Zed app > Agent Panel > select thread`,
    nonInteractive: `# No CLI resume — Zed AI threads are GUI-only`,
    description: 'Continue this Zed session (GUI only, no CLI resume)',
    verified: false,
  }),
};

export function getResumeHint(source: SessionSource, sessionId: string): ResumeHint {
  const template = RESUME_TEMPLATES[source];
  if (!template) {
    return {
      interactive: `# No known resume command for ${source}`,
      nonInteractive: `# No known resume command for ${source}`,
      description: `Continue this ${source} session`,
      verified: false,
    };
  }
  return template(sessionId);
}

export function formatResumeHintPlain(source: SessionSource, sessionId: string): string {
  const hint = getResumeHint(source, sessionId);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`Continue this session:`);
  lines.push(`  Interactive:      ${hint.interactive}`);
  lines.push(`  Non-interactive:  ${hint.nonInteractive}`);
  if (!hint.verified) {
    lines.push(`  [!] Not verified locally — please confirm with the tool's --help`);
  }
  return lines.join('\n');
}
