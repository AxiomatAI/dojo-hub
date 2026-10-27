import { z } from 'zod';

/** Trust status of a skill/suite version. `approved` versions are published. */
export const VERSION_STATUSES = [
  'draft',
  'submitted',
  'scanning',
  'in_review',
  'approved',
  'rejected',
  'deprecated',
  'blocked',
] as const;
export const versionStatus = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof versionStatus>;

/** Statuses whose content may be distributed to agents. */
export const INSTALLABLE_STATUSES: readonly VersionStatus[] = ['approved', 'deprecated'];

/** Allowed manual/automatic transitions of the trust state machine. */
export const VERSION_TRANSITIONS: Record<VersionStatus, readonly VersionStatus[]> = {
  draft: ['submitted'],
  submitted: ['scanning', 'rejected'],
  scanning: ['in_review', 'approved', 'rejected'],
  in_review: ['approved', 'rejected', 'draft'],
  approved: ['deprecated', 'blocked'],
  rejected: ['draft'],
  deprecated: ['approved', 'blocked'],
  blocked: ['approved', 'deprecated'],
};

export const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical'] as const;
export const riskLevel = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevel>;
export const riskRank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);

export const ORG_ROLES = ['owner', 'admin', 'security_reviewer', 'auditor', 'member'] as const;
export const orgRole = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRole>;

export const NAMESPACE_ROLES = ['owner', 'maintainer', 'reviewer', 'member'] as const;
export const namespaceRole = z.enum(NAMESPACE_ROLES);
export type NamespaceRole = z.infer<typeof namespaceRole>;

export const NAMESPACE_KINDS = ['org', 'team', 'personal'] as const;
export type NamespaceKind = (typeof NAMESPACE_KINDS)[number];

/** public: anyone (incl. anonymous well-known), internal: any signed-in org member, private: namespace members. */
export const VISIBILITIES = ['public', 'internal', 'private'] as const;
export const visibility = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof visibility>;

export const CATALOG_LEVELS = ['required', 'recommended', 'optional'] as const;
export const catalogLevel = z.enum(CATALOG_LEVELS);
export type CatalogLevel = z.infer<typeof catalogLevel>;

export const SOURCE_KINDS = ['github', 'gitlab', 'git', 'well_known', 'skills_sh', 'upload'] as const;
export const sourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKind>;

export const SOURCE_ITEM_STATUSES = ['new', 'imported', 'ignored', 'update_available', 'removed'] as const;
export type SourceItemStatus = (typeof SOURCE_ITEM_STATUSES)[number];

export const INSTALL_CHANNELS = ['wellknown', 'git', 'cli', 'api', 'mcp', 'web'] as const;
export type InstallChannel = (typeof INSTALL_CHANNELS)[number];

export const ASSET_FLAGS = [
  'script',
  'executable',
  'binary',
  'archive',
  'network',
  'fs-write',
  'env-access',
  'large',
  'obfuscated',
  'hidden-unicode',
] as const;
export type AssetFlag = (typeof ASSET_FLAGS)[number];

export const WEBHOOK_EVENTS = [
  'skill.submitted',
  'version.scanned',
  'review.requested',
  'review.decided',
  'version.published',
  'version.rejected',
  'version.deprecated',
  'version.blocked',
  'source.synced',
  'source.update_available',
  'install.recorded',
] as const;
export const webhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof webhookEvent>;

export const LLM_PROVIDERS = ['anthropic', 'openai', 'azure', 'bedrock', 'google', 'openai-compatible'] as const;
export const llmProvider = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof llmProvider>;

export const DECISIONS = ['approve', 'reject', 'request_changes'] as const;
export const decision = z.enum(DECISIONS);
export type Decision = z.infer<typeof decision>;

export const PAT_SCOPES = ['read', 'install', 'submit', 'review', 'admin'] as const;
export const patScope = z.enum(PAT_SCOPES);
export type PatScope = z.infer<typeof patScope>;
