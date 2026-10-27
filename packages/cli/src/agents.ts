import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent install locations, mirroring the `skills` CLI (vercel-labs/skills, src/agents.ts) so that
 * `dojo` and `npx skills` manage the same directories. Skills are written once to the canonical
 * `.agents/skills/<name>` directory and symlinked into each agent's directory.
 */
export interface Agent {
  id: string;
  name: string;
  project: string;
  global: string;
}

const home = homedir();
const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');

export const AGENTS: Agent[] = [
  { id: 'claude-code', name: 'Claude Code', project: '.claude/skills', global: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'skills') },
  { id: 'cursor', name: 'Cursor', project: '.agents/skills', global: join(home, '.cursor/skills') },
  { id: 'codex', name: 'Codex', project: '.agents/skills', global: join(process.env.CODEX_HOME ?? join(home, '.agents'), 'skills') },
  { id: 'github-copilot', name: 'GitHub Copilot', project: '.agents/skills', global: join(home, '.copilot/skills') },
  { id: 'gemini-cli', name: 'Gemini CLI', project: '.agents/skills', global: join(home, '.gemini/skills') },
  { id: 'opencode', name: 'OpenCode', project: '.agents/skills', global: join(xdg, 'opencode/skills') },
  { id: 'windsurf', name: 'Windsurf', project: '.windsurf/skills', global: join(home, '.codeium/windsurf/skills') },
  { id: 'cline', name: 'Cline', project: '.agents/skills', global: join(home, '.cline/skills') },
  { id: 'roo', name: 'Roo Code', project: '.roo/skills', global: join(home, '.roo/skills') },
  { id: 'goose', name: 'Goose', project: '.agents/skills', global: join(xdg, 'goose/skills') },
  { id: 'amp', name: 'Amp', project: '.agents/skills', global: join(xdg, 'agents/skills') },
  { id: 'kiro', name: 'Kiro', project: '.kiro/skills', global: join(home, '.kiro/skills') },
  { id: 'junie', name: 'Junie', project: '.junie/skills', global: join(home, '.junie/skills') },
  { id: 'qwen-code', name: 'Qwen Code', project: '.qwen/skills', global: join(home, '.qwen/skills') },
  { id: 'continue', name: 'Continue', project: '.continue/skills', global: join(home, '.continue/skills') },
];

export const CANONICAL_PROJECT = '.agents/skills';
export const CANONICAL_GLOBAL = join(home, '.agents/skills');

export function resolveAgents(ids: string[] | undefined): Agent[] {
  if (!ids?.length) return AGENTS.filter((a) => a.id === 'claude-code' || a.project === CANONICAL_PROJECT).slice(0, 2);
  if (ids.includes('*') || ids.includes('all')) return AGENTS;
  const out = AGENTS.filter((a) => ids.includes(a.id));
  const unknown = ids.filter((i) => !AGENTS.some((a) => a.id === i));
  if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(', ')}. Known: ${AGENTS.map((a) => a.id).join(', ')}`);
  return out;
}
