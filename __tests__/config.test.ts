import { describe, it, expect } from 'vitest';
import { getPreset, PRESET_NAMES } from '../src/config.js';

describe('config', () => {
  it('exports 4 preset names', () => {
    expect(PRESET_NAMES).toEqual(['minimal', 'standard', 'verbose', 'full']);
  });

  it('getPreset returns correct preset for each name', () => {
    for (const name of PRESET_NAMES) {
      const preset = getPreset(name);
      expect(preset.name).toBe(name);
    }
  });

  it('throws on unknown preset name', () => {
    expect(() => getPreset('unknown')).toThrow(/Unknown verbosity preset/);
  });

  it('minimal has lowest limits', () => {
    const p = getPreset('minimal');
    expect(p.maxContentChars).toBe(80);
    expect(p.showThinking).toBe(false);
    expect(p.showToolArgs).toBe(false);
    expect(p.showToolResults).toBe(false);
  });

  it('standard has moderate limits', () => {
    const p = getPreset('standard');
    expect(p.maxContentChars).toBe(500);
    expect(p.showThinking).toBe(false);
    expect(p.showToolArgs).toBe(true);
    expect(p.showToolResults).toBe(true);
  });

  it('verbose shows thinking', () => {
    const p = getPreset('verbose');
    expect(p.showThinking).toBe(true);
    expect(p.maxThinkingChars).toBeGreaterThan(0);
    expect(p.maxContentChars).toBe(2000);
  });

  it('full has infinite limits', () => {
    const p = getPreset('full');
    expect(p.maxContentChars).toBe(Infinity);
    expect(p.maxToolInputChars).toBe(Infinity);
    expect(p.maxToolResultChars).toBe(Infinity);
    expect(p.showThinking).toBe(true);
  });

  it('each preset has increasing maxContentChars', () => {
    const limits = PRESET_NAMES.map((n) => getPreset(n).maxContentChars);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1]);
    }
  });
});
