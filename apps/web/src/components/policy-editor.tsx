import { type PolicyDocument, RISK_LEVELS } from '@dojohub/contract';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, CardHeader, Field, Input, Segmented, Select, Switch, Textarea } from './ui';

const ROLE_OPTIONS = ['maintainer', 'reviewer', 'owner', 'security_reviewer', 'admin', 'auditor'];

/** Visual editor for the approval policy DSL, with a raw JSON escape hatch. */
export function PolicyEditor({
  value,
  onSave,
  saving,
  readOnly,
}: {
  value: PolicyDocument;
  onSave: (doc: PolicyDocument) => void;
  saving?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PolicyDocument>(value);
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [json, setJson] = useState(JSON.stringify(value, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  useEffect(() => {
    setDoc(value);
    setJson(JSON.stringify(value, null, 2));
  }, [value]);
  const set = <K extends keyof PolicyDocument>(k: K, v: PolicyDocument[K]) =>
    setDoc((d) => ({ ...d, [k]: v }));
  const save = () => {
    if (mode === 'json') {
      try {
        onSave(JSON.parse(json) as PolicyDocument);
        setJsonError(null);
      } catch (err) {
        setJsonError((err as Error).message);
      }
    } else onSave(doc);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Segmented
          value={mode}
          onChange={(m) => {
            if (m === 'json') setJson(JSON.stringify(doc, null, 2));
            else {
              try {
                setDoc(JSON.parse(json) as PolicyDocument);
              } catch {
                /* keep visual state */
              }
            }
            setMode(m);
          }}
          options={[
            { value: 'visual', label: t('policy.visual') },
            { value: 'json', label: t('policy.json') },
          ]}
        />
        {!readOnly && (
          <Button variant="primary" loading={saving} onClick={save}>
            {t('common.save')}
          </Button>
        )}
      </div>
      {mode === 'json' ? (
        <>
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={24}
            className="font-mono text-[12px]"
            readOnly={readOnly}
          />
          {jsonError && <p className="text-[12px] text-danger">{jsonError}</p>}
        </>
      ) : (
        <fieldset disabled={readOnly} className="space-y-4">
          <Card>
            <CardHeader title={t('policy.gates')} />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label={t('policy.maxRisk')}>
                <Select
                  value={doc.gates.maxRisk}
                  onChange={(e) =>
                    set('gates', {
                      ...doc.gates,
                      maxRisk: e.target.value as PolicyDocument['gates']['maxRisk'],
                    })
                  }
                >
                  {RISK_LEVELS.map((r) => (
                    <option key={r} value={r}>
                      {t(`riskLevel.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('policy.minClaims')}>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={doc.gates.minClaimsScore}
                  onChange={(e) => set('gates', { ...doc.gates, minClaimsScore: Number(e.target.value) })}
                />
              </Field>
              <Field
                label={t('policy.blockOn')}
                hint="secret, exec, destructive, prompt-injection, obfuscation…"
              >
                <Input
                  value={doc.gates.blockOn.join(', ')}
                  onChange={(e) =>
                    set('gates', {
                      ...doc.gates,
                      blockOn: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <div className="space-y-1">
                <Switch
                  checked={doc.gates.requireLlmVerification}
                  onCheckedChange={(v) => set('gates', { ...doc.gates, requireLlmVerification: v })}
                  label={t('policy.requireLlm')}
                />
                <Switch
                  checked={doc.gates.rejectExactDuplicates}
                  onCheckedChange={(v) => set('gates', { ...doc.gates, rejectExactDuplicates: v })}
                  label={t('policy.rejectDuplicates')}
                />
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader
              title={t('policy.stages')}
              actions={
                <Button
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() =>
                    set('stages', [
                      ...doc.stages,
                      {
                        name: `Stage ${doc.stages.length + 1}`,
                        approvers: { roles: ['maintainer'] },
                        min: 1,
                      },
                    ])
                  }
                >
                  {t('policy.addStage')}
                </Button>
              }
            />
            <div className="divide-y divide-border">
              {doc.stages.length === 0 && <p className="px-4 py-4 text-[13px] text-muted">—</p>}
              {doc.stages.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stages are positional
                <div key={i} className="grid gap-3 p-4 md:grid-cols-[20px_1fr_1fr_110px_32px]">
                  <GripVertical className="mt-7 hidden h-4 w-4 text-subtle md:block" />
                  <div className="space-y-3">
                    <Field label={`${i + 1}. ${t('policy.stageName')}`}>
                      <Input
                        value={s.name}
                        onChange={(e) =>
                          set(
                            'stages',
                            doc.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('policy.when')} hint={t('policy.whenHint')}>
                      <Input
                        value={s.when ?? ''}
                        onChange={(e) =>
                          set(
                            'stages',
                            doc.stages.map((x, j) =>
                              j === i ? { ...x, when: e.target.value || undefined } : x,
                            ),
                          )
                        }
                        className="font-mono text-[12px]"
                      />
                    </Field>
                  </div>
                  <div className="space-y-3">
                    <Field label={t('policy.roles')}>
                      <div className="flex flex-wrap gap-1.5">
                        {ROLE_OPTIONS.map((r) => {
                          const on = s.approvers.roles?.includes(r);
                          return (
                            <button
                              type="button"
                              key={r}
                              onClick={() =>
                                set(
                                  'stages',
                                  doc.stages.map((x, j) =>
                                    j === i
                                      ? {
                                          ...x,
                                          approvers: {
                                            ...x.approvers,
                                            roles: on
                                              ? x.approvers.roles?.filter((y) => y !== r)
                                              : [...(x.approvers.roles ?? []), r],
                                          },
                                        }
                                      : x,
                                  ),
                                )
                              }
                              className={`rounded-md border px-2 py-0.5 text-[12px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg'}`}
                            >
                              {t(`roles.${r}`)}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                    <Field label={t('policy.groups')}>
                      <Input
                        value={(s.approvers.groups ?? []).join(', ')}
                        placeholder="sec-team, 3f2a…"
                        onChange={(e) =>
                          set(
                            'stages',
                            doc.stages.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    approvers: {
                                      ...x.approvers,
                                      groups: e.target.value
                                        .split(',')
                                        .map((g) => g.trim())
                                        .filter(Boolean),
                                    },
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                  <Field label={t('policy.min')}>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={s.min}
                      onChange={(e) =>
                        set(
                          'stages',
                          doc.stages.map((x, j) =>
                            j === i ? { ...x, min: Number(e.target.value) || 1 } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mt-5"
                    aria-label={t('common.remove')}
                    onClick={() =>
                      set(
                        'stages',
                        doc.stages.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('policy.updates')} />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label={t('policy.updates')}>
                <Select
                  value={doc.updates.mode}
                  onChange={(e) =>
                    set('updates', {
                      ...doc.updates,
                      mode: e.target.value as PolicyDocument['updates']['mode'],
                    })
                  }
                >
                  {(['manual', 'auto_if_low_risk', 'auto'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`policy.updateMode.${m}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('policy.updateMaxRisk')}>
                <Select
                  value={doc.updates.maxRisk}
                  onChange={(e) =>
                    set('updates', {
                      ...doc.updates,
                      maxRisk: e.target.value as PolicyDocument['updates']['maxRisk'],
                    })
                  }
                >
                  {RISK_LEVELS.map((r) => (
                    <option key={r} value={r}>
                      {t(`riskLevel.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Switch
                checked={doc.updates.llmDiffReview}
                onCheckedChange={(v) => set('updates', { ...doc.updates, llmDiffReview: v })}
                label={t('policy.llmDiff')}
              />
              <Switch
                checked={doc.updates.majorRequiresManual}
                onCheckedChange={(v) => set('updates', { ...doc.updates, majorRequiresManual: v })}
                label={t('policy.majorManual')}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t('policy.imports')} />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label={t('policy.imports')}>
                <Select
                  value={doc.imports.mode}
                  onChange={(e) =>
                    set('imports', {
                      ...doc.imports,
                      mode: e.target.value as PolicyDocument['imports']['mode'],
                    })
                  }
                >
                  {(['manual', 'auto_if_trusted'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`policy.importMode.${m}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('policy.trustedSources')}>
                <Textarea
                  value={doc.imports.trustedSources.join('\n')}
                  rows={3}
                  className="font-mono text-[12px]"
                  onChange={(e) =>
                    set('imports', {
                      ...doc.imports,
                      trustedSources: e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Switch
                checked={doc.maintainersBypass}
                onCheckedChange={(v) => set('maintainersBypass', v)}
                label={t('policy.bypass')}
              />
            </div>
          </Card>
        </fieldset>
      )}
    </div>
  );
}
