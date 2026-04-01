/**
 * Barrel import — importing this module triggers registerSource() in all parser files.
 * Discovery.ts imports this to ensure all adapters are registered before use.
 */

// Existing parsers
import './claude.js';
import './codex.js';

// Tier 1: Simple file-based parsers
import './gemini.js';
import './copilot.js';
import './cursor-agent.js';
import './commandcode.js';

// Tier 2: Complex/SQLite parsers
import './goose.js';
import './opencode.js';
import './kiro.js';
import './zed.js';
