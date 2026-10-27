import { markdown } from '@codemirror/lang-markdown';
import type { NamespaceDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import CodeMirror from '@uiw/react-codemirror';
import { FilePlus2, FileUp, GitBranch, PenLine, Plus, Trash2, UploadCloud } from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FindingList } from '../components/dojo';
import { useMe } from '../components/shell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  Textarea,
} from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { cn, formatBytes } from '../lib/utils';

interface Validation {
  skills: {
    name: string;
    path: string;
    description: string;
    issues: { level: string; code: string; message: string }[];
    externalRefs: string[];
    files: { path: string; size: number }[];
    findings: {
      analyzer: string;
      rule: string;
      severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
      message: string;
      file?: string;
      line?: number;
      evidence?: string;
    }[];
  }[];
  suites: { name: string; version?: string; skills: string[] }[];
  warnings: string[];
}

function useWritableNamespaces() {
  const me = useMe();
  const q = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces') });
  const admin = me.permissions.includes('org.admin');
  return (q.data ?? []).filter((n) => admin || n.kind === 'org' || !!n.myRole);
}

function useDark() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function ValidationPanel({
  v,
  selected,
  onSelect,
}: {
  v: Validation;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {v.skills.length > 1 && <p className="text-[13px] text-muted">{t('submit.multipleSkills')}</p>}
      {v.skills.map((s) => {
        const errors = s.issues.filter((i) => i.level === 'error');
        return (
          <Card
            key={s.path}
            className={cn(
              'overflow-hidden',
              v.skills.length > 1 && selected === s.path && 'ring-2 ring-[var(--ring)]',
            )}
          >
            <button type="button" className="w-full text-left" onClick={() => onSelect(s.path)}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <code className="font-mono">{s.name}</code>
                    {errors.length ? (
                      <Badge tone="danger">{errors.length} errors</Badge>
                    ) : (
                      <Badge tone="ok">valid</Badge>
                    )}
                    <span className="text-[12px] font-normal text-subtle">
                      {t('count.files', { count: s.files.length })}
                    </span>
                  </span>
                }
                description={s.description}
              />
            </button>
            {s.issues.length > 0 && (
              <ul className="space-y-1 border-b border-border px-4 py-2 text-[12.5px]">
                {s.issues.map((i) => (
                  <li key={i.code + i.message} className={i.level === 'error' ? 'text-danger' : 'text-warn'}>
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            {s.findings.length > 0 && (
              <div>
                <div className="px-4 pt-2 text-[12px] font-medium text-subtle uppercase">
                  {t('submit.preScan')}
                </div>
                <FindingList findings={s.findings} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function UploadMode({ initialNamespace }: { initialNamespace?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const namespaces = useWritableNamespaces();
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validating, setValidating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [ns, setNs] = useState(initialNamespace ?? '');
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState<'submit' | 'draft' | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ns && namespaces.length)
      setNs(initialNamespace ?? namespaces.find((n) => n.kind === 'team')?.slug ?? namespaces[0]!.slug);
  }, [namespaces, ns, initialNamespace]);

  const pick = async (f: File) => {
    setFile(f);
    setValidation(null);
    setValidating(true);
    try {
      const v = await api.post<Validation>('skills/validate', f, {
        'content-type': 'application/octet-stream',
      });
      setValidation(v);
      setSelected(v.skills[0]?.path ?? null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setValidating(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void pick(f);
  };
  const submit = async (submitNow: boolean) => {
    if (!file) return;
    setBusy(submitNow ? 'submit' : 'draft');
    try {
      const params = new URLSearchParams({ namespace: ns, submit: String(submitNow) });
      if (version) params.set('version', version);
      if (changelog) params.set('changelog', changelog);
      if (selected !== null && (validation?.skills.length ?? 0) > 1) params.set('path', selected);
      const res = await api.post<{ skill: string; version: string }>(`skills/upload?${params}`, file, {
        'content-type': 'application/octet-stream',
      });
      toast.success(t('submit.submitted', { name: res.skill, version: res.version }));
      void navigate({
        to: '/skills/$name/versions/$version',
        params: { name: res.skill, version: res.version },
        search: { file: undefined },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const chosen = validation?.skills.find((s) => s.path === selected);
  const hasErrors = chosen?.issues.some((i) => i.level === 'error');
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border-strong bg-panel px-6 py-12 text-center transition-colors',
            drag && 'border-accent bg-accent-soft',
          )}
        >
          <UploadCloud className="mb-3 h-8 w-8 text-subtle" />
          <div className="font-medium">{file ? file.name : t('submit.dropzone')}</div>
          <div className="mt-1 text-[12.5px] text-subtle">
            {file ? formatBytes(file.size) : t('submit.browse')}
          </div>
          <input
            ref={input}
            type="file"
            accept=".zip,.tar,.gz,.tgz,.md"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
          />
        </label>
        {validating && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> {t('common.loading')}
          </div>
        )}
        {validation && <ValidationPanel v={validation} selected={selected} onSelect={setSelected} />}
      </div>
      <SubmitSidebar
        namespaces={namespaces}
        ns={ns}
        setNs={setNs}
        version={version}
        setVersion={setVersion}
        changelog={changelog}
        setChangelog={setChangelog}
        busy={busy}
        disabled={!file || !chosen || !!hasErrors}
        onSubmit={submit}
      />
    </div>
  );
}

function SubmitSidebar(props: {
  namespaces: NamespaceDto[];
  ns: string;
  setNs: (v: string) => void;
  version: string;
  setVersion: (v: string) => void;
  changelog: string;
  setChangelog: (v: string) => void;
  busy: 'submit' | 'draft' | null;
  disabled: boolean;
  onSubmit: (submit: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-4">
      <Field label={t('submit.targetNamespace')}>
        <Select value={props.ns} onChange={(e) => props.setNs(e.target.value)}>
          {props.namespaces.map((n) => (
            <option key={n.id} value={n.slug}>
              {n.displayName} (@{n.slug})
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('submit.version')} hint={t('submit.versionHint')}>
        <Input
          value={props.version}
          onChange={(e) => props.setVersion(e.target.value)}
          placeholder="1.0.0"
          className="font-mono"
        />
      </Field>
      <Field label={t('submit.changelog')}>
        <Textarea value={props.changelog} onChange={(e) => props.setChangelog(e.target.value)} rows={3} />
      </Field>
      <div className="flex flex-col gap-2 pt-1">
        <Button
          variant="primary"
          disabled={props.disabled}
          loading={props.busy === 'submit'}
          onClick={() => props.onSubmit(true)}
        >
          {t('submit.submitForReview')}
        </Button>
        <Button
          variant="ghost"
          disabled={props.disabled}
          loading={props.busy === 'draft'}
          onClick={() => props.onSubmit(false)}
        >
          {t('submit.saveDraft')}
        </Button>
      </div>
    </Card>
  );
}

function CreateMode({ initialNamespace }: { initialNamespace?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dark = useDark();
  const namespaces = useWritableNamespaces();
  const [files, setFiles] = useState<Record<string, string>>({ 'SKILL.md': t('submit.template') });
  const [active, setActive] = useState('SKILL.md');
  const [newPath, setNewPath] = useState('');
  const [ns, setNs] = useState(initialNamespace ?? '');
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState<'submit' | 'draft' | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  useEffect(() => {
    if (!ns && namespaces.length)
      setNs(namespaces.find((n) => n.kind === 'team')?.slug ?? namespaces[0]!.slug);
  }, [namespaces, ns]);
  const extensions = useMemo(() => [markdown()], []);
  useEffect(() => {
    const id = setTimeout(() => {
      api
        .post<Validation>('skills/validate', { files })
        .then(setValidation)
        .catch(() => {});
    }, 600);
    return () => clearTimeout(id);
  }, [files]);
  const submit = async (submitNow: boolean) => {
    setBusy(submitNow ? 'submit' : 'draft');
    try {
      const res = await api.post<{ skill: string; version: string }>('skills', {
        namespace: ns,
        files,
        version: version || undefined,
        changelog: changelog || undefined,
        submit: submitNow,
      });
      toast.success(t('submit.submitted', { name: res.skill, version: res.version }));
      void navigate({
        to: '/skills/$name/versions/$version',
        params: { name: res.skill, version: res.version },
        search: { file: undefined },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const errors = validation?.skills[0]?.issues.filter((i) => i.level === 'error') ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <Card className="grid overflow-hidden md:grid-cols-[200px_1fr]">
          <div className="border-b border-border bg-bg-subtle/60 p-2 md:border-r md:border-b-0">
            {Object.keys(files)
              .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))
              .map((p) => (
                <div
                  key={p}
                  className={cn(
                    'group flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px]',
                    active === p ? 'bg-accent-soft text-accent' : 'hover:bg-panel-hover',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono"
                    onClick={() => setActive(p)}
                  >
                    {p}
                  </button>
                  {p !== 'SKILL.md' && (
                    <button
                      type="button"
                      aria-label={t('common.remove')}
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => {
                        const { [p]: _, ...rest } = files;
                        setFiles(rest);
                        setActive('SKILL.md');
                      }}
                    >
                      <Trash2 className="h-3 w-3 text-subtle" />
                    </button>
                  )}
                </div>
              ))}
            <form
              className="mt-2 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const p = newPath.trim().replace(/^\/+/, '');
                if (!p || files[p] !== undefined) return;
                setFiles({ ...files, [p]: '' });
                setActive(p);
                setNewPath('');
              }}
            >
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="references/notes.md"
                className="h-7 font-mono text-[11.5px]"
              />
              <Button size="sm" type="submit" aria-label={t('submit.addFile')}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
          </div>
          <div className="min-w-0">
            <div className="border-b border-border px-4 py-2 font-mono text-[12.5px] text-muted">
              {active}
            </div>
            <CodeMirror
              value={files[active] ?? ''}
              height="480px"
              theme={dark ? 'dark' : 'light'}
              extensions={extensions}
              onChange={(v) => setFiles((f) => ({ ...f, [active]: v }))}
              basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
              className="text-[13px]"
            />
          </div>
        </Card>
        {errors.length > 0 && (
          <Card className="border-danger/30 p-3 text-[12.5px] text-danger">
            {errors.map((e) => (
              <div key={e.message}>{e.message}</div>
            ))}
          </Card>
        )}
      </div>
      <SubmitSidebar
        namespaces={namespaces}
        ns={ns}
        setNs={setNs}
        version={version}
        setVersion={setVersion}
        changelog={changelog}
        setChangelog={setChangelog}
        busy={busy}
        disabled={errors.length > 0 || !ns}
        onSubmit={submit}
      />
    </div>
  );
}

export function SubmitPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/app/submit' }) as { mode?: string; skill?: string; namespace?: string };
  const navigate = useNavigate();
  const mode = (search.mode ?? 'upload') as 'upload' | 'create' | 'import';
  return (
    <div>
      <PageHeader
        icon={<FilePlus2 className="h-4 w-4" />}
        title={search.skill ? `${t('skills.newVersion')} · ${search.skill}` : t('submit.title')}
        description={t('submit.subtitle')}
        actions={
          <Segmented
            value={mode}
            onChange={(m) =>
              m === 'import'
                ? navigate({ to: '/sources/new', search: { preset: undefined, url: undefined } })
                : navigate({ to: '/submit', search: { ...search, mode: m }, replace: true })
            }
            options={[
              {
                value: 'upload',
                label: (
                  <span className="flex items-center gap-1.5">
                    <FileUp className="h-3.5 w-3.5" />
                    {t('submit.upload')}
                  </span>
                ),
              },
              {
                value: 'create',
                label: (
                  <span className="flex items-center gap-1.5">
                    <PenLine className="h-3.5 w-3.5" />
                    {t('submit.create')}
                  </span>
                ),
              },
              {
                value: 'import',
                label: (
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" />
                    {t('submit.import')}
                  </span>
                ),
              },
            ]}
          />
        }
      />
      {mode === 'create' ? (
        <CreateMode initialNamespace={search.namespace} />
      ) : (
        <UploadMode initialNamespace={search.namespace} />
      )}
      <p className="mt-6 text-[12px] text-subtle">
        <Link to="/connect" className="hover:text-fg">
          dojo submit ./my-skill
        </Link>
      </p>
    </div>
  );
}
