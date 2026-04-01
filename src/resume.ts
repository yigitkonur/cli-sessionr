import type { SessionSource } from './types.js';

export interface ResumeHint {
  resume: string;
  resume_async: string;
  direct: string | null;
  verified: boolean;
  tip: string;
}

interface ToolDirect {
  cmd: (id: string) => string;
  verified: boolean;
  tip?: string;
}

const TOOL_DIRECTS: Record<SessionSource, ToolDirect | null> = {
  claude: {
    cmd: (id) => `claude -r ${id} -p "$(cat prompt.md)"`,
    verified: true,
  },
  codex: {
    cmd: (id) => `codex exec resume ${id} "$(cat prompt.md)"`,
    verified: true,
  },
  gemini: {
    cmd: (id) => `gemini -p "$(cat prompt.md)" -r "${id}"`,
    verified: true,
    tip: 'Gemini may need session index instead of UUID — run gemini --list-sessions',
  },
  'cursor-agent': {
    cmd: (id) => `agent -p --resume ${id} "$(cat prompt.md)"`,
    verified: true,
  },
  copilot: {
    cmd: (id) => `copilot -p "$(cat prompt.md)" --resume=${id}`,
    verified: true,
  },
  opencode: {
    cmd: (id) => `opencode run -s ${id} "$(cat prompt.md)"`,
    verified: true,
  },
  commandcode: {
    cmd: (id) => `cmd -p "$(cat prompt.md)" --resume ${id}`,
    verified: false,
  },
  goose: {
    cmd: (id) => `goose run --resume --session-id ${id} -t "$(cat prompt.md)"`,
    verified: false,
  },
  kiro: {
    cmd: () => `kiro-cli chat --no-interactive --resume`,
    verified: false,
    tip: 'Kiro resumes most recent session in cwd (cannot target by ID)',
  },
  zed: null,
};

export function getResumeHint(source: SessionSource, sessionId: string): ResumeHint {
  const base = `sessionr send ${sessionId} -f prompt.md --source ${source}`;
  const tool = TOOL_DIRECTS[source];

  const defaultTip = 'Write your prompt to prompt.md, then run resume. ' +
    'Async returns a job ID — poll: sessionr job <id> | wait: sessionr wait <id>';

  if (!tool) {
    return {
      resume: base,
      resume_async: `${base} --async`,
      direct: null,
      verified: false,
      tip: `${source} is GUI-only — use sessionr send instead. ${defaultTip}`,
    };
  }

  const tip = tool.tip
    ? `${tool.tip}. ${defaultTip}`
    : defaultTip;

  return {
    resume: base,
    resume_async: `${base} --async`,
    direct: tool.cmd(sessionId),
    verified: tool.verified,
    tip,
  };
}

export function formatResumeHintPlain(source: SessionSource, sessionId: string): string {
  const hint = getResumeHint(source, sessionId);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`Resume: ${hint.resume}`);
  lines.push(`Async:  ${hint.resume_async}`);
  if (hint.direct) {
    lines.push(`Direct: ${hint.direct}`);
  }
  lines.push(`Tip:    ${hint.tip}`);
  if (!hint.verified) {
    lines.push('[!] Direct command not verified locally — confirm with tool --help');
  }
  return lines.join('\n');
}
