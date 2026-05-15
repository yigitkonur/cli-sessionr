import { describe, it, expect } from 'vitest';
import { getPreset, getPresetForDetail, PRESET_NAMES } from '../src/config.js';
import { EXIT, SessionReaderError } from '../src/errors.js';

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
    expect(() => getPreset('unknown')).toThrow(SessionReaderError);
    try {
      getPreset('unknown');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as SessionReaderError).code).toBe('INVALID_PRESET');
      expect((err as SessionReaderError).exitCode).toBe(EXIT.USAGE);
      expect((err as SessionReaderError).detail).toEqual({
        provided: 'unknown',
        valid: PRESET_NAMES,
      });
    }
  });

  it('throws structured errors on unknown detail level', () => {
    expect(() => getPresetForDetail('dense' as never)).toThrow(SessionReaderError);
    try {
      getPresetForDetail('dense' as never);
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as SessionReaderError).code).toBe('INVALID_DETAIL');
      expect((err as SessionReaderError).exitCode).toBe(EXIT.USAGE);
      expect((err as SessionReaderError).detail).toEqual({
        provided: 'dense',
        valid: ['full', 'condensed', 'skeleton', 'meta'],
      });
    }
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
