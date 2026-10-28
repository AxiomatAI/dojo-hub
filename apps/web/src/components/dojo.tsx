import type {
  FindingDto,
  InstallCommands,
  RiskLevel,
  SkillSummaryDto,
  VersionStatus,
} from '@dojohub/contract';
import { Link } from '@tanstack/react-router';
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleDot,
  Clock,
  Download,
  FileCode2,
  FileText,
  Folder,
  Info,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { formatNumber, relativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge, Button, CopyField, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from './ui';

// ───────── Trust status ─────────
const STATUS_STYLE: Record<VersionStatus, { icon: ReactNode; cls: string }> = {
  draft: { icon: <CircleDashed className="h-3.5 w-3.5" />, cls: 'text-subtle bg-bg-subtle border-border' },
  submitted: { icon: <Clock className="h-3.5 w-3.5" />, cls: 'text-info bg-info/10 border-transparent' },
  scanning: {
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    cls: 'text-info bg-info/10 border-transparent',
  },
  in_review: { icon: <CircleDot className="h-3.5 w-3.5" />, cls: 'text-warn bg-warn/10 border-transparent' },
  approved: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, cls: 'text-ok bg-ok/10 border-transparent' },
  rejected: { icon: <XCircle className="h-3.5 w-3.5" />, cls: 'text-danger bg-danger/10 border-transparent' },
  deprecated: {
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    cls: 'text-muted bg-bg-subtle border-border',
  },
  blocked: { icon: <Ban className="h-3.5 w-3.5" />, cls: 'text-white bg-danger border-transparent' },
};

export function StatusPill({
  status,
  className,
  withHelp = true,
}: {
  status: VersionStatus;
  className?: string;
  withHelp?: boolean;
}) {
  const { t } = useTranslation();
  const s = STATUS_STYLE[status];
  const pill = (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11.5px] font-medium',
        s.cls,
        className,
      )}
    >
      {s.icon}
      {t(`status.${status}`)}
    </span>
  );
  return withHelp ? <Tooltip content={t(`status.help.${status}`)}>{pill}</Tooltip> : pill;
}

export function StatusIcon({ status }: { status: VersionStatus }) {
  return (
    <span className={cn('inline-flex', STATUS_STYLE[status].cls.split(' ')[0])}>
      {STATUS_STYLE[status].icon}
    </span>
  );
}

// ───────── Risk ─────────
const RISK_TONE: Record<RiskLevel, 'ok' | 'info' | 'warn' | 'danger' | 'neutral'> = {
  none: 'ok',
  low: 'info',
  medium: 'warn',
  high: 'danger',
  critical: 'danger',
};

export function RiskBadge({ level, score }: { level: RiskLevel | null; score?: number | null }) {
  const { t } = useTranslation();
  if (!level) return <Badge>{t('riskLevel.unscanned')}</Badge>;
  return (
    <Badge tone={RISK_TONE[level]} className={level === 'critical' ? 'bg-danger text-white' : undefined}>
      {level === 'none' ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
      {t(`riskLevel.${level}`)}
      {typeof score === 'number' && score > 0 && <span className="opacity-70">· {score}</span>}
    </Badge>
  );
}

const SEVERITY_ICON: Record<FindingDto['severity'], ReactNode> = {
  info: <Info className="h-3.5 w-3.5 text-info" />,
  low: <Info className="h-3.5 w-3.5 text-muted" />,
  medium: <AlertTriangle className="h-3.5 w-3.5 text-warn" />,
  high: <AlertOctagon className="h-3.5 w-3.5 text-danger" />,
  critical: <AlertOctagon className="h-3.5 w-3.5 text-danger" />,
};

export function SeverityBadge({ severity }: { severity: FindingDto['severity'] }) {
  const { t } = useTranslation();
  const tone =
    severity === 'critical' || severity === 'high'
      ? 'danger'
      : severity === 'medium'
        ? 'warn'
        : severity === 'low'
          ? 'neutral'
          : 'info';
  return (
    <Badge tone={tone} className={severity === 'critical' ? 'bg-danger text-white' : undefined}>
      {t(`severity.${severity}`)}
    </Badge>
  );
}

export function FindingList({
  findings,
  onFile,
}: {
  findings: FindingDto[];
  onFile?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  if (!sorted.length) return <p className="px-4 py-3 text-[13px] text-muted">{t('security.noFindings')}</p>;
  return (
    <ul className="divide-y divide-border">
      {sorted.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: findings can repeat the same rule on one line
        <li key={`${f.rule}-${i}`} className="flex gap-3 px-4 py-2.5">
          <span className="mt-0.5">{SEVERITY_ICON[f.severity]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px]">{f.message}</span>
              <SeverityBadge severity={f.severity} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-subtle">
              <code className="font-mono">{f.rule}</code>
              {f.file && (
                <button
                  type="button"
                  className="font-mono hover:text-accent"
                  onClick={() => onFile?.(f.file!)}
                >
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </button>
              )}
            </div>
            {f.evidence && (
              <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-bg-subtle px-2 py-1 font-mono text-[11.5px] text-muted">
                {f.evidence}
              </pre>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ───────── Namespaces & skills ─────────
export function NamespaceChip({ slug, color }: { slug: string; color?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
      <span className="h-2 w-2 rounded-sm" style={{ background: color ?? 'var(--fg-subtle)' }} />@{slug}
    </span>
  );
}

export function SkillGlyph({ name, size = 32 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg border border-border font-mono font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${hue} 60% 55% / .18), hsl(${(hue + 40) % 360} 60% 55% / .06))`,
        color: `hsl(${hue} 55% 55%)`,
      }}
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function SkillRow({ skill, right }: { skill: SkillSummaryDto; right?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/skills/$name"
      params={{ name: skill.name }}
      className="group flex items-center gap-3 border-b border-border px-4 py-2.5 transition-colors last:border-b-0 hover:bg-panel-hover"
    >
      <SkillGlyph name={skill.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{skill.displayName}</span>
          <code className="hidden truncate font-mono text-[11.5px] text-subtle sm:inline">{skill.name}</code>
        </div>
        <p className="truncate text-[12.5px] text-muted">{skill.summary}</p>
      </div>
      <div className="hidden items-center gap-3 md:flex">
        <NamespaceChip slug={skill.namespace} />
        {(skill.publishedVersion ?? skill.latestVersion) && (
          <code className="font-mono text-[11.5px] text-subtle">
            v{skill.publishedVersion ?? skill.latestVersion}
          </code>
        )}
        <span className="w-14 text-right text-[12px] text-subtle tabular-nums" title={t('common.installs')}>
          <Download className="mr-1 inline h-3 w-3" />
          {formatNumber(skill.installCount)}
        </span>
        <RiskBadge level={skill.riskLevel} />
      </div>
      <StatusPill status={skill.status} withHelp={false} />
      {right}
      <span className="hidden w-20 text-right text-[12px] text-subtle lg:inline">
        {relativeTime(skill.updatedAt)}
      </span>
    </Link>
  );
}

// ───────── Install ─────────
export function InstallMenu({ install, label }: { install: InstallCommands; label?: string }) {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="primary" icon={<Terminal className="h-3.5 w-3.5" />}>
          {label ?? t('skills.install')}
          <ChevronDown className="h-3.5 w-3.5 opacity-80" />
        </Button>
      </MenuTrigger>
      <MenuContent className="w-[min(560px,calc(100vw-24px))] p-3">
        <MenuLabel>{t('skills.installVia')}</MenuLabel>
        <div className="mt-1 space-y-2">
          {install.npxWellKnown && <CopyField label="npx" value={install.npxWellKnown} />}
          <CopyField label="git" value={install.npxGit} />
          <CopyField label="dojo" value={install.dojo} />
        </div>
        <p className="mt-2 text-[11.5px] text-subtle">{t('connect.telemetry')}</p>
      </MenuContent>
    </Menu>
  );
}

export function InstallPanel({ install }: { install: InstallCommands }) {
  return (
    <div className="space-y-2">
      {install.npxWellKnown && <CopyField label="npx" value={install.npxWellKnown} />}
      <CopyField label="git" value={install.npxGit} />
      <CopyField label="dojo" value={install.dojo} />
    </div>
  );
}

// ───────── Content rendering ─────────
export function Markdown({
  children,
  stripFrontmatter = true,
}: {
  children: string;
  stripFrontmatter?: boolean;
}) {
  const text = stripFrontmatter ? children.replace(/^﻿?---[\s\S]*?\n---\s*\n?/, '') : children;
  return (
    <div className="prose-dojo">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sql: 'sql',
  toml: 'toml',
  ps1: 'powershell',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
};

export function CodeView({ path, code }: { path: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text';
  useEffect(() => {
    let alive = true;
    setHtml(null);
    if (code.length > 200_000) return;
    import('shiki')
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang,
          themes: { light: 'github-light', dark: 'github-dark-dimmed' },
          defaultColor: 'light',
        }),
      )
      .then((h) => alive && setHtml(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, lang]);
  const lines = useMemo(() => code.split('\n').length, [code]);
  return (
    <div className="flex overflow-x-auto font-mono text-[12.5px] leading-[1.65]">
      <div className="sticky left-0 shrink-0 border-r border-border bg-panel px-3 py-3 text-right text-subtle select-none">
        {Array.from({ length: lines }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line numbers
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is escaped HTML
        <div className="min-w-0 flex-1 px-4 py-3 [&_pre]:!m-0" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="min-w-0 flex-1 px-4 py-3 whitespace-pre">{code}</pre>
      )}
    </div>
  );
}

export function fileIcon(path: string) {
  if (/\.(md|mdx|txt)$/i.test(path)) return <FileText className="h-3.5 w-3.5" />;
  return <FileCode2 className="h-3.5 w-3.5" />;
}

export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: { path: string; riskFlags?: string[]; size?: number }[];
  selected?: string | null;
  onSelect: (p: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof files>();
    for (const f of [...files].sort((a, b) =>
      a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path),
    )) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      map.set(dir, [...(map.get(dir) ?? []), f]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [files]);
  return (
    <div className="space-y-2 py-2 text-[12.5px]">
      {groups.map(([dir, list]) => (
        <div key={dir}>
          {dir && (
            <div className="flex items-center gap-1.5 px-3 py-1 text-subtle">
              <Folder className="h-3.5 w-3.5" />
              <span className="truncate font-mono">{dir}/</span>
            </div>
          )}
          {list.map((f) => (
            <button
              type="button"
              key={f.path}
              onClick={() => onSelect(f.path)}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-panel-hover',
                dir && 'pl-6',
                selected === f.path && 'bg-accent-soft text-accent',
              )}
            >
              <span className="text-subtle">{fileIcon(f.path)}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{f.path.split('/').pop()}</span>
              {f.riskFlags?.some((r) =>
                ['binary', 'obfuscated', 'hidden-unicode', 'executable'].includes(r),
              ) && <ShieldAlert className="h-3 w-3 text-danger" />}
              {f.riskFlags?.includes('script') && <Terminal className="h-3 w-3 text-warn" />}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function RiskFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  const danger = ['binary', 'obfuscated', 'hidden-unicode', 'executable'];
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge
          key={f}
          tone={danger.includes(f) ? 'danger' : f === 'script' || f === 'network' ? 'warn' : 'neutral'}
        >
          {f}
        </Badge>
      ))}
    </div>
  );
}

export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  return (
    <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            l.startsWith('+') && 'bg-ok/10 text-ok',
            l.startsWith('-') && 'bg-danger/10 text-danger',
            l.startsWith('@@') && 'bg-bg-subtle py-0.5 text-subtle',
          )}
        >
          {l === '@@' ? '⋯' : l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function ScoreBar({ level, label, max = 5 }: { level: number; label: ReactNode; max?: number }) {
  const color = level >= 4 ? 'bg-ok' : level >= 3 ? 'bg-warn' : 'bg-danger';
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12.5px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">
          {level}/{max}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-subtle">
        <div
          className={cn('h-full rounded-full', color)}
          style={{ width: `${Math.max(2, (level / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}
