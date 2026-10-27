import type { DuplicateDto, ScanRunDto, VersionFileDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, Copy, Download, FileSearch, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../lib/utils';
import { CodeView, FileTree, FindingList, Markdown, RiskFlags, ScoreBar } from './dojo';
import { Badge, Card, CardHeader, EmptyState, Spinner } from './ui';

export interface VersionDetail {
  id: string;
  version: string;
  status: string;
  files: VersionFileDto[];
  scans: ScanRunDto[];
  duplicates: DuplicateDto[];
  riskLevel: string | null;
  riskScore: number | null;
}

export function FilesBrowser({ skill, version, files, initial }: { skill: string; version: string; files: VersionFileDto[]; initial?: string }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(initial ?? (files.some((f) => f.path === 'SKILL.md') ? 'SKILL.md' : (files[0]?.path ?? null)));
  useEffect(() => {
    if (initial) setSelected(initial);
  }, [initial]);
  const file = files.find((f) => f.path === selected);
  const isText = file && (file.mime.startsWith('text/') || /json|yaml|xml|toml|javascript|typescript|x-sh/.test(file.mime));
  const content = useQuery({
    queryKey: ['file', skill, version, selected],
    queryFn: async () => {
      const res = await fetch(`/api/v1/skills/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}/files/${selected!.split('/').map(encodeURIComponent).join('/')}`, { credentials: 'include' });
      return res.text();
    },
    enabled: !!selected && !!isText,
  });
  const isImage = file?.mime.startsWith('image/') && file.mime !== 'image/svg+xml';
  return (
    <Card className="grid min-h-[420px] overflow-hidden md:grid-cols-[240px_1fr]">
      <div className="border-b border-border bg-bg-subtle/60 md:border-r md:border-b-0">
        <FileTree files={files} selected={selected} onSelect={setSelected} />
      </div>
      <div className="min-w-0">
        {!file ? (
          <EmptyState icon={<FileSearch className="h-5 w-5" />} title={t('skills.selectFile')} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <code className="font-mono text-[12.5px]">{file.path}</code>
              <span className="text-[12px] text-subtle">{formatBytes(file.size)}</span>
              <RiskFlags flags={file.riskFlags} />
              <a
                className="ml-auto text-subtle hover:text-fg"
                href={`/api/v1/skills/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`}
                download={file.path.split('/').pop()}
                aria-label={t('skills.download')}
              >
                <Download className="h-4 w-4" />
              </a>
            </div>
            {isText ? (
              content.isLoading ? (
                <div className="flex justify-center p-10">
                  <Spinner />
                </div>
              ) : file.path.endsWith('.md') ? (
                <div className="px-6 py-5">
                  <Markdown>{content.data ?? ''}</Markdown>
                </div>
              ) : (
                <CodeView path={file.path} code={content.data ?? ''} />
              )
            ) : isImage ? (
              <div className="flex justify-center p-6">
                <img
                  alt={file.path}
                  className="max-h-96 rounded border border-border"
                  src={`/api/v1/skills/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`}
                />
              </div>
            ) : (
              <EmptyState icon={<Copy className="h-5 w-5" />} title={t('skills.binaryFile')} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function SecurityReport({ detail, skill, onFile }: { detail: VersionDetail; skill: string; onFile?: (p: string) => void }) {
  const { t } = useTranslation();
  if (['submitted', 'scanning'].includes(detail.status) && !detail.scans.length) {
    return (
      <Card className="flex items-center gap-3 p-5 text-muted">
        <Spinner /> {t('security.scanPending')}
      </Card>
    );
  }
  const llm = detail.scans.find((s) => s.analyzer === 'llm');
  const report = llm?.report as
    | { summary?: string; category?: string; claimsMatch?: { score: number; explanation: string; mismatches: string[] }; quality?: { score: number; notes: string[] }; security?: { verdict: string } }
    | null
    | undefined;
  const ordered = ['structure', 'static', 'secrets', 'assets', 'dependencies', 'llm', 'decision_model', 'duplicates', 'pipeline'];
  const scans = [...detail.scans].sort((a, b) => ordered.indexOf(a.analyzer) - ordered.indexOf(b.analyzer));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-accent" />
              {t('security.analyzer.llm')}
            </span>
          }
          actions={report?.security?.verdict && <Badge tone={report.security.verdict === 'safe' ? 'ok' : report.security.verdict === 'suspicious' ? 'warn' : 'danger'}>{report.security.verdict}</Badge>}
        />
        {llm?.status === 'done' && report ? (
          <div className="grid gap-5 p-4 md:grid-cols-[1fr_260px]">
            <div>
              <div className="mb-1 text-[12px] font-medium text-subtle uppercase">{t('security.llmSummary')}</div>
              <p className="text-[13.5px] leading-relaxed">{report.summary}</p>
              {!!report.claimsMatch?.mismatches?.length && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-warn">
                  {report.claimsMatch.mismatches.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
              {llm.model && <p className="mt-3 text-[11.5px] text-subtle">{llm.model}</p>}
            </div>
            <div className="space-y-4">
              {report.claimsMatch && <ScoreBar value={report.claimsMatch.score} label={t('security.claimsMatch')} />}
              {report.quality && <ScoreBar value={report.quality.score} label={t('security.quality')} />}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 px-4 py-3 text-[13px] text-muted">
            {llm?.error ?? t('security.llmSkipped')}
            <Link to="/admin" search={{ tab: 'verification' }} className="text-accent">
              {t('security.configureLlm')}
            </Link>
          </div>
        )}
      </Card>

      {detail.duplicates.length > 0 && (
        <Card>
          <CardHeader title={t('security.duplicates')} />
          <ul>
            {detail.duplicates.map((d) => (
              <li key={`${d.versionId}-${d.kind}`} className="flex items-center gap-3 border-b border-border px-4 py-2 text-[13px] last:border-b-0">
                <Badge tone={d.kind === 'exact' ? 'warn' : 'neutral'}>{d.kind}</Badge>
                <span className="text-muted">{t('security.similarTo', { score: Math.round(d.score * 100) })}</span>
                <Link to="/skills/$name" params={{ name: d.skillName }} className="font-medium hover:text-accent">
                  {d.skillName}
                </Link>
                <span className="font-mono text-[12px] text-subtle">
                  @{d.namespace} v{d.version}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {scans
        .filter((s) => s.analyzer !== 'llm' || s.findings.length)
        .map((s) => (
          <Card key={s.analyzer}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-subtle" />
                  {t(`security.analyzer.${s.analyzer}`, { defaultValue: s.analyzer })}
                </span>
              }
              actions={
                <>
                  {s.status === 'skipped' ? (
                    <Badge>{t('common.disabled')}</Badge>
                  ) : s.status === 'error' ? (
                    <Badge tone="warn">{s.error?.slice(0, 60) ?? 'error'}</Badge>
                  ) : (
                    <Badge tone={s.verdict === 'fail' ? 'danger' : s.verdict === 'warn' ? 'warn' : 'ok'}>{t(`security.${s.verdict ?? 'pass'}`)}</Badge>
                  )}
                  <span className="text-[12px] text-subtle">{t('count.findings', { count: s.findings.length })}</span>
                </>
              }
            />
            {s.status !== 'skipped' && <FindingList findings={s.findings} onFile={(f) => onFile?.(f)} />}
          </Card>
        ))}
    </div>
  );
}
