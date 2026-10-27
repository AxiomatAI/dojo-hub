import { z } from 'zod';
import { riskLevel } from './enums';

export const approversSchema = z.object({
  users: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});

export const policyStageSchema = z.object({
  name: z.string().min(1).max(80),
  /** Optional condition in the policy expression language, e.g. `risk >= "medium" or has_asset("script")`. */
  when: z.string().max(500).optional(),
  approvers: approversSchema,
  min: z.number().int().min(1).max(10).default(1),
});

export const policyDocumentSchema = z.object({
  gates: z
    .object({
      /** Versions above this risk level are rejected automatically. */
      maxRisk: riskLevel.default('high'),
      requireLlmVerification: z.boolean().default(false),
      /** Finding rule ids/categories that reject immediately. */
      blockOn: z.array(z.string()).default(['secret']),
      /** Minimum "does what it claims" score from the LLM judge (0-100). */
      minClaimsScore: z.number().int().min(0).max(100).default(0),
      /** Reject on exact duplicates of existing approved skills. */
      rejectExactDuplicates: z.boolean().default(false),
    })
    .default({
      maxRisk: 'high',
      requireLlmVerification: false,
      blockOn: ['secret'],
      minClaimsScore: 0,
      rejectExactDuplicates: false,
    }),
  stages: z.array(policyStageSchema).max(10).default([]),
  updates: z
    .object({
      mode: z.enum(['manual', 'auto_if_low_risk', 'auto']).default('manual'),
      llmDiffReview: z.boolean().default(true),
      maxRisk: riskLevel.default('low'),
      majorRequiresManual: z.boolean().default(true),
    })
    .default({ mode: 'manual', llmDiffReview: true, maxRisk: 'low', majorRequiresManual: true }),
  imports: z
    .object({
      /** Source URLs (prefix match) whose imports skip human stages when gates pass. */
      trustedSources: z.array(z.string()).default([]),
      mode: z.enum(['manual', 'auto_if_trusted']).default('manual'),
    })
    .default({ trustedSources: [], mode: 'manual' }),
  /** Allow privileged namespace maintainers to publish without review. */
  maintainersBypass: z.boolean().default(false),
});

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
export type PolicyStage = z.infer<typeof policyStageSchema>;

export const DEFAULT_POLICY: PolicyDocument = policyDocumentSchema.parse({
  gates: { maxRisk: 'high', requireLlmVerification: false, blockOn: ['secret'], minClaimsScore: 0 },
  stages: [
    {
      name: 'Security review',
      when: 'risk >= "medium" or has_asset("script")',
      approvers: { roles: ['security_reviewer'] },
      min: 1,
    },
    { name: 'Team approval', approvers: { roles: ['maintainer'] }, min: 1 },
  ],
  updates: { mode: 'auto_if_low_risk', llmDiffReview: true, maxRisk: 'low', majorRequiresManual: true },
});
