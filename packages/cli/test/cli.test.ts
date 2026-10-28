import { describe, expect, it } from 'vitest';
import { AGENTS, CANONICAL_PROJECT, resolveAgents } from '../src/agents';
import { normalizeUrl, registryName } from '../src/config';

describe('config', () => {
  it('normalizes registry URLs', () => {
    expect(normalizeUrl('dojo.example.com')).toBe('https://dojo.example.com');
    expect(normalizeUrl('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(normalizeUrl('https://x.y///')).toBe('https://x.y');
  });

  it('derives the registry name from the host', () => {
    expect(registryName('https://dojo.example.com:8443')).toBe('dojo.example.com:8443');
  });
});

describe('resolveAgents', () => {
  it('defaults to a small set anchored on the canonical project', () => {
    const agents = resolveAgents(undefined);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.length).toBeLessThanOrEqual(2);
    expect(agents.some((a) => a.project === CANONICAL_PROJECT)).toBe(true);
  });

  it('resolves explicit ids and rejects unknown ones', () => {
    expect(resolveAgents(['cursor', 'windsurf']).map((a) => a.id)).toEqual(['cursor', 'windsurf']);
    expect(resolveAgents(['*'])).toHaveLength(AGENTS.length);
    expect(() => resolveAgents(['nope'])).toThrow(/Unknown agent/);
  });
});
