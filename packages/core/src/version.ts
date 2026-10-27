import semver from 'semver';

export type BumpKind = 'major' | 'minor' | 'patch';

export function isValidVersion(v: string): boolean {
  return semver.valid(v) !== null;
}

export function nextVersion(previous: string | null | undefined, bump: BumpKind = 'patch'): string {
  if (!previous || !semver.valid(previous)) return '1.0.0';
  return semver.inc(previous, bump) ?? '1.0.0';
}

export function compareVersions(a: string, b: string): number {
  return semver.compare(a, b);
}

export function isGreater(a: string, b: string): boolean {
  return semver.gt(a, b);
}

export function bumpKindBetween(from: string, to: string): BumpKind | null {
  const d = semver.diff(from, to);
  if (d === 'major' || d === 'premajor') return 'major';
  if (d === 'minor' || d === 'preminor') return 'minor';
  if (d) return 'patch';
  return null;
}

/**
 * Suggest a bump for an upstream change. Frontmatter name/description/allowed-tools changes alter
 * how agents select and use the skill, so they are treated as interface (minor) changes.
 */
export function suggestBump(
  prevFrontmatter: Record<string, unknown>,
  nextFrontmatter: Record<string, unknown>,
  removedFiles: number,
): BumpKind {
  if (prevFrontmatter.name !== nextFrontmatter.name) return 'major';
  const keys = ['description', 'allowed-tools', 'compatibility'];
  if (keys.some((k) => JSON.stringify(prevFrontmatter[k]) !== JSON.stringify(nextFrontmatter[k])))
    return 'minor';
  if (removedFiles > 0) return 'minor';
  return 'patch';
}

/** Resolve a version selector ("latest", exact, or a semver range) against available versions. */
export function resolveVersion(available: string[], selector?: string | null): string | null {
  const sorted = available.filter((v) => semver.valid(v)).sort(semver.rcompare);
  if (!selector || selector === 'latest') return sorted[0] ?? null;
  if (semver.valid(selector)) return sorted.includes(selector) ? selector : null;
  return semver.maxSatisfying(sorted, selector);
}
