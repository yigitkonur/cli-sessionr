import { parseClaudeSession, registerSource, read, listSessions } from '../../src/index.js';
import type { SourceAdapter, NormalizedSession, SessionListEntry, ReadEnvelope } from '../../src/index.js';

const source = 'custom-handoff';
const adapter: SourceAdapter = {
  name: source,
  label: 'Custom handoff',
  color: 'blue',
  find: async (): Promise<SessionListEntry[]> => [{
    id: 'custom-session', source, cwd: '/synthetic', updatedAt: new Date(0), filePath: '/synthetic/session.jsonl',
  }],
  parse: async (filePath): Promise<NormalizedSession> => ({
    ...await parseClaudeSession(filePath), source,
  }),
};

registerSource(adapter);
const response: ReadEnvelope = await read({ path: '/synthetic/session.jsonl', source });
const sources: SessionListEntry[] = await listSessions(source);
void response;
void sources;
