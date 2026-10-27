import type {
  AssetFlag,
  CatalogLevel,
  Decision,
  InstallChannel,
  LlmProvider,
  NamespaceKind,
  NamespaceRole,
  OrgRole,
  PatScope,
  RiskLevel,
  SourceItemStatus,
  SourceKind,
  VersionStatus,
  Visibility,
  WebhookEvent,
} from '@dojohub/contract';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const newId = () => crypto.randomUUID();

const id = () => text('id').primaryKey().$defaultFn(newId);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();
/** Every tenant-owned table carries org_id; repositories always filter by it. */
const orgId = () =>
  text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

/** pgvector column without a fixed dimension (embedding models vary under BYOK). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (v) => `[${v.join(',')}]`,
  fromDriver: (v) => JSON.parse(v),
});

// ───────────────────────────── Organisation & identity ─────────────────────────────

export const organization = pgTable('organization', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
});

export const orgMember = pgTable(
  'org_member',
  {
    orgId: orgId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrgRole>().notNull().default('member'),
    /** Whether the role was granted by an IdP group mapping (re-evaluated on sync) or manually. */
    managed: boolean('managed').default(false).notNull(),
    lastSeenAt: ts('last_seen_at'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const idpGroup = pgTable(
  'idp_group',
  {
    id: id(),
    orgId: orgId(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    source: text('source').$type<'claim' | 'scim' | 'directory_sync' | 'manual'>().notNull(),
    providerId: text('provider_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idp_group_ext_idx').on(t.orgId, t.externalId)],
);

export const groupMembership = pgTable(
  'group_membership',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => idpGroup.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: text('source').$type<'claim' | 'scim' | 'directory_sync' | 'manual'>().notNull(),
    syncedAt: ts('synced_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** IdP group → org role (namespaceId null) or namespace role. */
export const groupMapping = pgTable('group_mapping', {
  id: id(),
  orgId: orgId(),
  groupId: text('group_id')
    .notNull()
    .references(() => idpGroup.id, { onDelete: 'cascade' }),
  namespaceId: text('namespace_id').references(() => namespace.id, { onDelete: 'cascade' }),
  orgRole: text('org_role').$type<OrgRole>(),
  namespaceRole: text('namespace_role').$type<NamespaceRole>(),
  createdAt: createdAt(),
});

/** Personal access tokens & service-account tokens (CLI, git, API, MCP). Only a hash is stored. */
export const accessToken = pgTable(
  'access_token',
  {
    id: id(),
    orgId: orgId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().$type<PatScope[]>().notNull(),
    kind: text('kind').$type<'personal' | 'service' | 'cli'>().default('personal').notNull(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('access_token_user_idx').on(t.userId)],
);

/** OAuth 2.0 device authorization grant for `dojo login`. */
export const deviceCode = pgTable('device_code', {
  deviceCodeHash: text('device_code_hash').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  clientName: text('client_name').notNull(),
  status: text('status').$type<'pending' | 'approved' | 'denied' | 'consumed'>().default('pending').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  orgId: text('org_id').references(() => organization.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  lastPolledAt: ts('last_polled_at'),
  createdAt: createdAt(),
});

export const scimToken = pgTable('scim_token', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

/** SCIM-provisioned users keep their external id + active flag here. */
export const scimUser = pgTable(
  'scim_user',
  {
    orgId: orgId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    userName: text('user_name').notNull(),
    active: boolean('active').default(true).notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ───────────────────────────── Namespaces / teams ─────────────────────────────

export const namespace = pgTable(
  'namespace',
  {
    id: id(),
    orgId: orgId(),
    slug: text('slug').notNull(),
    kind: text('kind').$type<NamespaceKind>().notNull().default('team'),
    displayName: text('display_name').notNull(),
    description: text('description'),
    visibility: text('visibility').$type<Visibility>().notNull().default('internal'),
    color: text('color'),
    icon: text('icon'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('namespace_slug_idx').on(t.orgId, t.slug)],
);

export const namespaceMember = pgTable(
  'namespace_member',
  {
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<NamespaceRole>().notNull().default('member'),
    managed: boolean('managed').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.namespaceId, t.userId] })],
);

// ───────────────────────────── Skills & versions ─────────────────────────────

export interface Provenance {
  sourceId?: string;
  sourceKind?: SourceKind;
  url?: string;
  ref?: string;
  commit?: string;
  path?: string;
  license?: string;
  fetchedAt?: string;
  uploadedFilename?: string;
}

export interface Transformation {
  kind: 'rename' | 'vendor_external' | 'strip_root' | 'frontmatter_patch';
  detail: string;
}

export const skill = pgTable(
  'skill',
  {
    id: id(),
    orgId: orgId(),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespace.id, { onDelete: 'restrict' }),
    /** Install name (agentskills `name`); unique per org because agents key install dirs by name. */
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().$type<string[]>().default(sql`'{}'`).notNull(),
    category: text('category'),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    sourceId: text('source_id').references(() => source.id, { onDelete: 'set null' }),
    upstreamPath: text('upstream_path'),
    upstreamRemoved: boolean('upstream_removed').default(false).notNull(),
    /** Denormalised trust status of the most relevant version (latest approved, else latest). */
    status: text('status').$type<VersionStatus>().notNull().default('draft'),
    riskLevel: text('risk_level').$type<RiskLevel>(),
    latestVersionId: text('latest_version_id'),
    publishedVersionId: text('published_version_id'),
    installCount: integer('install_count').default(0).notNull(),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skill_name_idx').on(t.orgId, t.name),
    index('skill_namespace_idx').on(t.namespaceId),
    index('skill_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${t.name} || ' ' || ${t.displayName} || ' ' || ${t.summary})`,
    ),
  ],
);

export const skillVersion = pgTable(
  'skill_version',
  {
    id: id(),
    orgId: orgId(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    status: text('status').$type<VersionStatus>().notNull().default('draft'),
    statusReason: text('status_reason'),
    changelog: text('changelog'),
    description: text('description').notNull().default(''),
    frontmatter: jsonb('frontmatter').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    archiveDigest: text('archive_digest').notNull(),
    archiveSize: integer('archive_size').notNull(),
    fileCount: integer('file_count').notNull(),
    totalSize: integer('total_size').notNull(),
    riskScore: integer('risk_score'),
    riskLevel: text('risk_level').$type<RiskLevel>(),
    /** MinHash signature for near-duplicate detection. */
    fingerprint: jsonb('fingerprint').$type<number[]>(),
    provenance: jsonb('provenance').$type<Provenance>().default({}).notNull(),
    transformations: jsonb('transformations').$type<Transformation[]>().default([]).notNull(),
    externalRefs: text('external_refs').array().$type<string[]>().default(sql`'{}'`).notNull(),
    submittedBy: text('submitted_by').references(() => user.id, { onDelete: 'set null' }),
    submittedAt: ts('submitted_at'),
    publishedAt: ts('published_at'),
    decidedAt: ts('decided_at'),
    installCount: integer('install_count').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skill_version_idx').on(t.skillId, t.version),
    index('skill_version_status_idx').on(t.orgId, t.status),
    index('skill_version_hash_idx').on(t.orgId, t.contentHash),
  ],
);

export const versionFile = pgTable(
  'version_file',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => skillVersion.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    mime: text('mime').notNull(),
    riskFlags: text('risk_flags').array().$type<AssetFlag[]>().default(sql`'{}'`).notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.path] })],
);

export const skillEmbedding = pgTable('skill_embedding', {
  versionId: text('version_id')
    .primaryKey()
    .references(() => skillVersion.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  model: text('model').notNull(),
  embedding: vector('embedding').notNull(),
  createdAt: createdAt(),
});

// ───────────────────────────── Suites ─────────────────────────────

export const suite = pgTable(
  'suite',
  {
    id: id(),
    orgId: orgId(),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags').array().$type<string[]>().default(sql`'{}'`).notNull(),
    sourceId: text('source_id').references(() => source.id, { onDelete: 'set null' }),
    homepage: text('homepage'),
    author: text('author'),
    license: text('license'),
    status: text('status').$type<VersionStatus>().notNull().default('draft'),
    latestVersionId: text('latest_version_id'),
    publishedVersionId: text('published_version_id'),
    installCount: integer('install_count').default(0).notNull(),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('suite_name_idx').on(t.orgId, t.namespaceId, t.name)],
);

export const suiteVersion = pgTable(
  'suite_version',
  {
    id: id(),
    orgId: orgId(),
    suiteId: text('suite_id')
      .notNull()
      .references(() => suite.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    status: text('status').$type<VersionStatus>().notNull().default('draft'),
    statusReason: text('status_reason'),
    changelog: text('changelog'),
    /** Non-skill plugin assets (agents/, docs/, logos) stored as path → sha256. */
    assets: jsonb('assets').$type<{ path: string; sha256: string; size: number }[]>().default([]).notNull(),
    provenance: jsonb('provenance').$type<Provenance>().default({}).notNull(),
    riskLevel: text('risk_level').$type<RiskLevel>(),
    submittedBy: text('submitted_by').references(() => user.id, { onDelete: 'set null' }),
    submittedAt: ts('submitted_at'),
    publishedAt: ts('published_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suite_version_idx').on(t.suiteId, t.version)],
);

export const suiteMember = pgTable(
  'suite_member',
  {
    suiteVersionId: text('suite_version_id')
      .notNull()
      .references(() => suiteVersion.id, { onDelete: 'cascade' }),
    skillVersionId: text('skill_version_id')
      .notNull()
      .references(() => skillVersion.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    isEntry: boolean('is_entry').default(false).notNull(),
  },
  (t) => [primaryKey({ columns: [t.suiteVersionId, t.skillVersionId] })],
);

// ───────────────────────────── Team catalogs ─────────────────────────────

export const catalogEntry = pgTable(
  'catalog_entry',
  {
    id: id(),
    orgId: orgId(),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespace.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').references(() => skill.id, { onDelete: 'cascade' }),
    suiteId: text('suite_id').references(() => suite.id, { onDelete: 'cascade' }),
    /** null = follow latest approved version. */
    pinnedVersion: text('pinned_version'),
    level: text('level').$type<CatalogLevel>().notNull().default('recommended'),
    note: text('note'),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('catalog_skill_idx').on(t.namespaceId, t.skillId),
    uniqueIndex('catalog_suite_idx').on(t.namespaceId, t.suiteId),
  ],
);

// ───────────────────────────── Downstream sources ─────────────────────────────

export const source = pgTable('source', {
  id: id(),
  orgId: orgId(),
  namespaceId: text('namespace_id')
    .notNull()
    .references(() => namespace.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<SourceKind>().notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  ref: text('ref'),
  include: text('include').array().$type<string[]>().default(sql`'{}'`).notNull(),
  exclude: text('exclude').array().$type<string[]>().default(sql`'{}'`).notNull(),
  /** Encrypted credential (e.g. GitHub token) for private upstreams. */
  credentialEnc: text('credential_enc'),
  syncCron: text('sync_cron'),
  autoTrack: boolean('auto_track').default(true).notNull(),
  /** Prefix applied to imported skill names to avoid collisions (e.g. "mp-"). */
  namePrefix: text('name_prefix'),
  status: text('status').$type<'idle' | 'syncing' | 'error'>().default('idle').notNull(),
  lastError: text('last_error'),
  lastCommit: text('last_commit'),
  lastSyncedAt: ts('last_synced_at'),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sourceSnapshot = pgTable('source_snapshot', {
  id: id(),
  sourceId: text('source_id')
    .notNull()
    .references(() => source.id, { onDelete: 'cascade' }),
  commit: text('commit'),
  discovered: jsonb('discovered').$type<unknown>().notNull(),
  warnings: text('warnings').array().$type<string[]>().default(sql`'{}'`).notNull(),
  fetchedAt: ts('fetched_at').defaultNow().notNull(),
});

export const sourceItem = pgTable(
  'source_item',
  {
    id: id(),
    orgId: orgId(),
    sourceId: text('source_id')
      .notNull()
      .references(() => source.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'skill' | 'suite'>().notNull(),
    upstreamPath: text('upstream_path').notNull(),
    upstreamName: text('upstream_name').notNull(),
    description: text('description'),
    skillId: text('skill_id').references(() => skill.id, { onDelete: 'set null' }),
    suiteId: text('suite_id').references(() => suite.id, { onDelete: 'set null' }),
    status: text('status').$type<SourceItemStatus>().notNull().default('new'),
    lastContentHash: text('last_content_hash'),
    upstreamContentHash: text('upstream_content_hash'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('source_item_idx').on(t.sourceId, t.kind, t.upstreamPath, t.upstreamName)],
);

// ───────────────────────────── Policies & approvals ─────────────────────────────

export const policy = pgTable(
  'policy',
  {
    id: id(),
    orgId: orgId(),
    /** null = organisation default. */
    namespaceId: text('namespace_id').references(() => namespace.id, { onDelete: 'cascade' }),
    document: jsonb('document').$type<unknown>().notNull(),
    revision: integer('revision').default(1).notNull(),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('policy_ns_idx').on(t.orgId, t.namespaceId)],
);

export interface Approvers {
  users?: string[];
  groups?: string[];
  roles?: (OrgRole | NamespaceRole)[];
}

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: id(),
    orgId: orgId(),
    skillVersionId: text('skill_version_id').references(() => skillVersion.id, { onDelete: 'cascade' }),
    suiteVersionId: text('suite_version_id').references(() => suiteVersion.id, { onDelete: 'cascade' }),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespace.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'new' | 'update' | 'import' | 'unblock'>().notNull().default('new'),
    status: text('status').$type<'pending' | 'approved' | 'rejected' | 'cancelled'>().notNull().default('pending'),
    policySnapshot: jsonb('policy_snapshot').$type<unknown>().notNull(),
    currentStage: integer('current_stage').default(0).notNull(),
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    closedAt: ts('closed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('approval_request_status_idx').on(t.orgId, t.status)],
);

export const approvalStage = pgTable('approval_stage', {
  id: id(),
  requestId: text('request_id')
    .notNull()
    .references(() => approvalRequest.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  approvers: jsonb('approvers').$type<Approvers>().notNull(),
  minApprovals: integer('min_approvals').default(1).notNull(),
  status: text('status').$type<'waiting' | 'active' | 'approved' | 'rejected' | 'skipped'>().notNull(),
  completedAt: ts('completed_at'),
});

export const approvalDecision = pgTable('approval_decision', {
  id: id(),
  requestId: text('request_id')
    .notNull()
    .references(() => approvalRequest.id, { onDelete: 'cascade' }),
  stageId: text('stage_id').references(() => approvalStage.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
  /** 'system' for automated gate decisions. */
  actorType: text('actor_type').$type<'user' | 'system'>().notNull().default('user'),
  decision: text('decision').$type<Decision>().notNull(),
  comment: text('comment'),
  createdAt: createdAt(),
});

// ───────────────────────────── Scanning ─────────────────────────────

export interface Finding {
  analyzer: string;
  rule: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export const scanRun = pgTable(
  'scan_run',
  {
    id: id(),
    orgId: orgId(),
    skillVersionId: text('skill_version_id').references(() => skillVersion.id, { onDelete: 'cascade' }),
    analyzer: text('analyzer').notNull(),
    status: text('status').$type<'queued' | 'running' | 'done' | 'error' | 'skipped'>().notNull(),
    verdict: text('verdict').$type<'pass' | 'warn' | 'fail'>(),
    riskScore: integer('risk_score'),
    findings: jsonb('findings').$type<Finding[]>().default([]).notNull(),
    /** Analyzer-specific structured output (e.g. LLM judge report). */
    report: jsonb('report').$type<Record<string, unknown>>(),
    model: text('model'),
    tokens: integer('tokens'),
    error: text('error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [index('scan_run_version_idx').on(t.skillVersionId)],
);

export const duplicateMatch = pgTable(
  'duplicate_match',
  {
    id: id(),
    orgId: orgId(),
    versionId: text('version_id')
      .notNull()
      .references(() => skillVersion.id, { onDelete: 'cascade' }),
    otherVersionId: text('other_version_id')
      .notNull()
      .references(() => skillVersion.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'exact' | 'near' | 'semantic'>().notNull(),
    score: real('score').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('duplicate_version_idx').on(t.versionId)],
);

// ───────────────────────────── Installs & stats ─────────────────────────────

export const installEvent = pgTable(
  'install_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgId(),
    skillId: text('skill_id').references(() => skill.id, { onDelete: 'cascade' }),
    skillVersionId: text('skill_version_id').references(() => skillVersion.id, { onDelete: 'set null' }),
    suiteId: text('suite_id').references(() => suite.id, { onDelete: 'cascade' }),
    namespaceId: text('namespace_id').references(() => namespace.id, { onDelete: 'set null' }),
    channel: text('channel').$type<InstallChannel>().notNull(),
    isUpdate: boolean('is_update').default(false).notNull(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    userAgent: text('user_agent'),
    clientHash: text('client_hash'),
    createdAt: createdAt(),
  },
  (t) => [index('install_event_time_idx').on(t.orgId, t.createdAt), index('install_event_skill_idx').on(t.skillId)],
);

export const dailyStat = pgTable(
  'daily_stat',
  {
    orgId: orgId(),
    day: date('day').notNull(),
    subjectType: text('subject_type').$type<'skill' | 'suite'>().notNull(),
    subjectId: text('subject_id').notNull(),
    channel: text('channel').$type<InstallChannel>().notNull(),
    installs: integer('installs').default(0).notNull(),
    updates: integer('updates').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day, t.subjectType, t.subjectId, t.channel] })],
);

// ───────────────────────────── Integrations ─────────────────────────────

export const webhook = pgTable('webhook', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secretEnc: text('secret_enc').notNull(),
  events: text('events').array().$type<WebhookEvent[]>().notNull(),
  format: text('format').$type<'json' | 'slack' | 'teams'>().default('json').notNull(),
  namespaceId: text('namespace_id').references(() => namespace.id, { onDelete: 'cascade' }),
  active: boolean('active').default(true).notNull(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: id(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhook.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    event: text('event').$type<WebhookEvent>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<'pending' | 'success' | 'failed'>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [index('webhook_delivery_hook_idx').on(t.webhookId, t.createdAt)],
);

export const llmConfig = pgTable(
  'llm_config',
  {
    id: id(),
    orgId: orgId(),
    purpose: text('purpose').$type<'judge' | 'embedding'>().notNull(),
    provider: text('provider').$type<LlmProvider>().notNull(),
    model: text('model').notNull(),
    baseUrl: text('base_url'),
    apiKeyEnc: text('api_key_enc'),
    options: jsonb('options').$type<Record<string, unknown>>().default({}).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('llm_config_purpose_idx').on(t.orgId, t.purpose)],
);

export const decisionModel = pgTable('decision_model', {
  id: id(),
  orgId: orgId()
    .unique(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secretEnc: text('secret_enc'),
  timeoutMs: integer('timeout_ms').default(15000).notNull(),
  /** What to do when the model is unreachable. */
  onError: text('on_error').$type<'review' | 'ignore'>().default('review').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  updatedAt: updatedAt(),
});

export const directorySync = pgTable('directory_sync', {
  id: id(),
  orgId: orgId(),
  kind: text('kind').$type<'microsoft_graph' | 'google_directory'>().notNull(),
  configEnc: text('config_enc').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  lastRunAt: ts('last_run_at'),
  lastStatus: text('last_status'),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgId(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    actorType: text('actor_type').$type<'user' | 'system' | 'token' | 'scim'>().notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_time_idx').on(t.orgId, t.createdAt)],
);

export const notification = pgTable(
  'notification',
  {
    id: id(),
    orgId: orgId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notification_user_idx').on(t.userId, t.createdAt)],
);

export const setting = pgTable(
  'setting',
  {
    orgId: orgId(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);
