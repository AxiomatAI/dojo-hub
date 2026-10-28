import { z } from 'zod';
import {
  type AssetFlag,
  type CatalogLevel,
  catalogLevel,
  decision,
  type InstallChannel,
  llmProvider,
  type NamespaceRole,
  namespaceRole,
  type OrgRole,
  orgRole,
  patScope,
  type RiskLevel,
  type SourceItemStatus,
  type SourceKind,
  sourceKind,
  type VersionStatus,
  type Visibility,
  visibility,
  webhookEvent,
} from './enums';
import { policyDocumentSchema } from './policy';

// ───────────── Requests ─────────────

export const createNamespaceBody = z.object({
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  visibility: visibility.default('internal'),
  color: z.string().max(20).optional(),
});
export const updateNamespaceBody = createNamespaceBody.omit({ slug: true }).partial();

export const addMemberBody = z.object({ userId: z.string(), role: namespaceRole });
export const groupMappingBody = z.object({
  groupId: z.string(),
  namespaceId: z.string().nullable().optional(),
  orgRole: orgRole.optional(),
  namespaceRole: namespaceRole.optional(),
});

export const createSkillBody = z.object({
  namespace: z.string(),
  /** Files as path → UTF-8 text (in-browser authoring). Paths are fully validated on ingestion. */
  files: z.record(z.string().min(1).max(1024), z.string()),
  version: z.string().optional(),
  changelog: z.string().max(5000).optional(),
  submit: z.boolean().default(true),
});

export const submitVersionQuery = z.object({
  namespace: z.string(),
  version: z.string().optional(),
  changelog: z.string().optional(),
  submit: z.coerce.boolean().default(true),
});

export const reviewDecisionBody = z.object({ decision, comment: z.string().max(5000).optional() });
export const versionStatusBody = z.object({
  status: z.enum(['deprecated', 'blocked', 'approved']),
  reason: z.string().max(2000).optional(),
});

export const catalogEntryBody = z.object({
  skillId: z.string().optional(),
  suiteId: z.string().optional(),
  pinnedVersion: z.string().nullable().optional(),
  level: catalogLevel.default('recommended'),
  note: z.string().max(500).optional(),
});

export const createSuiteBody = z.object({
  namespace: z.string(),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  description: z.string().max(2000).default(''),
  version: z.string().default('1.0.0'),
  members: z
    .array(z.object({ skillVersionId: z.string(), isEntry: z.boolean().default(false) }))
    .min(1)
    .max(100),
  submit: z.boolean().default(true),
});

export const createSourceBody = z.object({
  namespace: z.string(),
  kind: sourceKind,
  name: z.string().min(1).max(120),
  url: z.string().min(1),
  ref: z.string().optional(),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  credential: z.string().optional(),
  syncCron: z.string().optional(),
  autoTrack: z.boolean().default(true),
  namePrefix: z.string().max(20).optional(),
});

export const importItemsBody = z.object({
  items: z.array(z.string()).min(1),
  /** Import selected suites as suites (with their skills). */
  asSuites: z.boolean().default(true),
});

export const createTokenBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(patScope).min(1),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export const webhookBody = z.object({
  name: z.string().min(1).max(80),
  url: z.url(),
  events: z.array(webhookEvent).min(1),
  format: z.enum(['json', 'slack', 'teams']).default('json'),
  namespaceId: z.string().nullable().optional(),
  active: z.boolean().default(true),
});

export const llmConfigBody = z.object({
  purpose: z.enum(['judge', 'embedding']),
  provider: llmProvider,
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export const decisionModelBody = z.object({
  name: z.string().min(1),
  url: z.url(),
  secret: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(15000),
  onError: z.enum(['review', 'ignore']).default('review'),
  enabled: z.boolean().default(true),
});

export const ssoProviderBody = z.object({
  preset: z.enum(['entra', 'google', 'okta', 'auth0', 'keycloak', 'oidc', 'saml']),
  providerId: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  domain: z.string().min(3),
  issuer: z.string().min(1),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  discoveryUrl: z.string().optional(),
  groupsClaim: z.string().default('groups'),
  samlEntryPoint: z.string().optional(),
  samlCert: z.string().optional(),
});

export const policyBody = z.object({ document: policyDocumentSchema });

export const setupBody = z.object({
  token: z.string().optional(),
  orgName: z.string().min(1).max(80),
  admin: z.object({ name: z.string().min(1), email: z.email(), password: z.string().min(10) }).optional(),
  locale: z.enum(['en-US', 'en-GB', 'pl']).default('en-US'),
});

// ───────────── Responses ─────────────

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface Me extends UserSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** URL of the organisation icon (cache-busted), or null for the default logo. */
  orgIconUrl: string | null;
  role: OrgRole;
  locale?: string | null;
  namespaces: { id: string; slug: string; displayName: string; role: NamespaceRole }[];
  permissions: string[];
}

export interface NamespaceDto {
  id: string;
  slug: string;
  kind: string;
  displayName: string;
  description: string | null;
  visibility: Visibility;
  color: string | null;
  memberCount: number;
  skillCount: number;
  catalogCount: number;
  myRole?: NamespaceRole | null;
}

export interface SkillSummaryDto {
  id: string;
  name: string;
  displayName: string;
  summary: string;
  namespace: string;
  namespaceName: string;
  status: VersionStatus;
  riskLevel: RiskLevel | null;
  latestVersion: string | null;
  publishedVersion: string | null;
  installCount: number;
  tags: string[];
  category: string | null;
  sourceName?: string | null;
  updatedAt: string;
  teams?: { slug: string; level: CatalogLevel }[];
}

export interface VersionFileDto {
  path: string;
  sha256: string;
  size: number;
  mime: string;
  riskFlags: AssetFlag[];
}

export interface FindingDto {
  analyzer: string;
  rule: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface ScanRunDto {
  analyzer: string;
  status: string;
  verdict: 'pass' | 'warn' | 'fail' | null;
  riskScore: number | null;
  findings: FindingDto[];
  report: Record<string, unknown> | null;
  model: string | null;
  error: string | null;
  finishedAt: string | null;
}

export interface DuplicateDto {
  kind: 'exact' | 'near' | 'semantic';
  score: number;
  skillName: string;
  namespace: string;
  version: string;
  versionId: string;
}

export interface VersionDto {
  id: string;
  version: string;
  status: VersionStatus;
  statusReason: string | null;
  changelog: string | null;
  description: string;
  frontmatter: Record<string, unknown>;
  contentHash: string;
  archiveDigest: string;
  fileCount: number;
  totalSize: number;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  provenance: Record<string, unknown>;
  transformations: { kind: string; detail: string }[];
  externalRefs: string[];
  submittedBy: UserSummary | null;
  submittedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  installCount: number;
}

export interface SkillDetailDto extends SkillSummaryDto {
  owner: UserSummary | null;
  upstreamPath: string | null;
  upstreamRemoved: boolean;
  source: { id: string; name: string; url: string; kind: SourceKind } | null;
  versions: VersionDto[];
  suites: { id: string; name: string; namespace: string }[];
  install: InstallCommands;
  canEdit: boolean;
  canReview: boolean;
}

export interface InstallCommands {
  npxWellKnown: string | null;
  npxGit: string;
  dojo: string;
  gitUrl: string;
  wellKnownUrl: string | null;
}

export interface ApprovalStageDto {
  id: string;
  position: number;
  name: string;
  status: string;
  minApprovals: number;
  approvers: { users?: string[]; groups?: string[]; roles?: string[] };
  decisions: {
    actor: UserSummary | null;
    actorType: string;
    decision: string;
    comment: string | null;
    createdAt: string;
  }[];
  canDecide: boolean;
}

export interface ReviewDto {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  requestedBy: UserSummary | null;
  namespace: string;
  subject: {
    type: 'skill' | 'suite';
    id: string;
    name: string;
    displayName: string;
    version: string;
    versionId: string;
    previousVersion: string | null;
    previousVersionId: string | null;
    riskLevel: RiskLevel | null;
    riskScore: number | null;
  };
  stages: ApprovalStageDto[];
  systemDecisions: { decision: string; comment: string | null; createdAt: string }[];
  canDecide: boolean;
}

export interface SuiteDto {
  id: string;
  name: string;
  displayName: string;
  description: string;
  namespace: string;
  status: VersionStatus;
  latestVersion: string | null;
  publishedVersion: string | null;
  installCount: number;
  author: string | null;
  license: string | null;
  homepage: string | null;
  skillCount: number;
  members?: {
    skillId: string;
    name: string;
    displayName: string;
    version: string;
    versionId: string;
    status: VersionStatus;
    isEntry: boolean;
  }[];
  install?: InstallCommands;
}

export interface SourceDto {
  id: string;
  kind: SourceKind;
  name: string;
  url: string;
  ref: string | null;
  namespace: string;
  status: string;
  lastError: string | null;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  autoTrack: boolean;
  syncCron: string | null;
  namePrefix: string | null;
  include: string[];
  exclude: string[];
  itemCounts: Record<SourceItemStatus, number>;
}

export interface SourceItemDto {
  id: string;
  kind: 'skill' | 'suite';
  upstreamPath: string;
  upstreamName: string;
  description: string | null;
  status: SourceItemStatus;
  skillId: string | null;
  suiteId: string | null;
  meta: Record<string, unknown>;
}

export interface PresetSource {
  id: string;
  kind: SourceKind;
  name: string;
  url: string;
  description: string;
  kindLabel: 'suite' | 'collection';
}

export interface DashboardDto {
  totals: {
    skills: number;
    suites: number;
    published: number;
    pendingReviews: number;
    installs30d: number;
    blocked: number;
    teams: number;
    users: number;
  };
  installsByDay: { day: string; installs: number; updates: number }[];
  installsByChannel: { channel: InstallChannel; installs: number }[];
  topSkills: { id: string; name: string; namespace: string; installs: number }[];
  topSuites: { id: string; name: string; namespace: string; installs: number }[];
  teamAdoption: { slug: string; displayName: string; installs: number; catalogSize: number }[];
  riskDistribution: { level: RiskLevel | 'unscanned'; count: number }[];
  statusDistribution: { status: VersionStatus; count: number }[];
  pipeline: { submitted: number; approved: number; rejected: number; medianReviewHours: number | null };
}

export interface TokenDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  kind: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AuditEntryDto {
  id: number;
  actor: UserSummary | null;
  actorType: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SearchResultForSkillsCli {
  skills: { id: string; name: string; source: string; installs: number; description?: string }[];
}

export interface SetupStatus {
  needsSetup: boolean;
  orgName: string | null;
  orgIconUrl: string | null;
  /** Serve the catalog without a session (network-gated deployments). */
  anonymousBrowsing: boolean;
  localAuth: boolean;
  ssoProviders: { providerId: string; domain: string; name: string }[];
  version: string;
  onboarding: { hasSso: boolean; hasLlm: boolean; hasTeam: boolean; hasSkills: boolean };
}
