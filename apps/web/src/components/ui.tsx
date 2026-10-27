import { Check, ChevronDown, Copy, Loader2, X } from 'lucide-react';
import { Checkbox as RCheckbox, Dialog as RDialog, DropdownMenu as RMenu, Switch as RSwitch, Tabs as RTabs, Tooltip as RTooltip } from 'radix-ui';
import { type ComponentProps, forwardRef, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, copyText, initials } from '../lib/utils';

// ───────── Buttons ─────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary: 'bg-panel border border-border-strong hover:bg-panel-hover text-fg shadow-sm',
  outline: 'border border-border-strong hover:bg-panel-hover text-fg',
  ghost: 'hover:bg-panel-hover text-muted hover:text-fg',
  danger: 'bg-danger/90 text-white hover:bg-danger shadow-sm',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' | 'icon'; loading?: boolean; icon?: ReactNode }
>(({ className, variant = 'secondary', size = 'md', loading, icon, children, disabled, ...props }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' && 'h-7 px-2.5 text-[12.5px]',
      size === 'md' && 'h-8 px-3 text-[13px]',
      size === 'lg' && 'h-10 px-4 text-sm',
      size === 'icon' && 'h-8 w-8',
      variants[variant],
      className,
    )}
    {...props}
  >
    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
    {children}
  </button>
));
Button.displayName = 'Button';

// ───────── Inputs ─────────
const fieldBase =
  'w-full rounded-md border border-border-strong bg-panel px-2.5 text-[13px] text-fg placeholder:text-subtle transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, 'h-8', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, 'min-h-20 py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select className={cn(fieldBase, 'h-8 appearance-none pr-7', className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-2 right-2 h-4 w-4 text-subtle" />
    </div>
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: generic label wrapper
  return <label className={cn('mb-1 block text-[12.5px] font-medium text-muted', className)} {...props} />;
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] text-subtle">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      {label && (
        <div>
          <div className="text-[13px] font-medium">{label}</div>
          {description && <div className="text-[12.5px] text-muted">{description}</div>}
        </div>
      )}
      <RSwitch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <RSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </RSwitch.Root>
    </div>
  );
}

export function Checkbox({ checked, onCheckedChange, className }: { checked: boolean | 'indeterminate'; onCheckedChange: (v: boolean) => void; className?: string }) {
  return (
    <RCheckbox.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border-strong bg-panel data-[state=checked]:border-accent data-[state=checked]:bg-accent', className)}
    >
      <RCheckbox.Indicator>
        <Check className="h-3 w-3 text-white" strokeWidth={3} />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

// ───────── Surfaces ─────────
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-border bg-panel shadow-panel', className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-muted">{icon}</div>}
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 max-w-2xl text-[13px] text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ className, tone = 'neutral', children, ...props }: ComponentProps<'span'> & { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' }) {
  const tones = {
    neutral: 'bg-bg-subtle text-muted border-border',
    accent: 'bg-accent-soft text-accent border-transparent',
    ok: 'bg-ok/10 text-ok border-transparent',
    warn: 'bg-warn/10 text-warn border-transparent',
    danger: 'bg-danger/10 text-danger border-transparent',
    info: 'bg-info/10 text-info border-transparent',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-[11.5px] font-medium', tones[tone], className)} {...props}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-bg-subtle px-1 font-mono text-[10.5px] text-subtle">{children}</kbd>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-subtle', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-subtle', className)} />;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg-subtle text-subtle">{icon}</div>}
      <div className="font-medium">{title}</div>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Avatar({ name, image, size = 22 }: { name: string; image?: string | null; size?: number }) {
  if (image) return <img src={image} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  const hue = [...name].reduce((h, c) => (h + c.charCodeAt(0) * 7) % 360, 0);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 45% 52%)` }}
    >
      {initials(name)}
    </span>
  );
}

export function CopyField({ value, className, label }: { value: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  const { t } = useTranslation();
  return (
    <div className={cn('group flex items-center gap-2 rounded-md border border-border bg-bg-subtle py-1 pr-1 pl-2.5', className)}>
      {label && <span className="shrink-0 text-[11.5px] text-subtle">{label}</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{value}</code>
      <button
        type="button"
        onClick={async () => {
          await copyText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }}
        className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] text-muted hover:bg-panel-hover hover:text-fg"
        aria-label={t('common.copy')}
      >
        {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// ───────── Overlays ─────────
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <RDialog.Content
          className={cn(
            'animate-in fixed top-[12vh] left-1/2 z-50 max-h-[76vh] w-[calc(100vw-32px)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-panel shadow-float',
            wide ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4">
            <div>
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-1 text-[13px] text-muted">{description}</RDialog.Description>}
            </div>
            <RDialog.Close className="rounded p-1 text-subtle hover:bg-panel-hover hover:text-fg">
              <X className="h-4 w-4" />
            </RDialog.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border bg-bg-subtle/50 px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;
export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <RMenu.Portal>
      <RMenu.Content align={align} sideOffset={6} className={cn('animate-in z-50 min-w-48 rounded-lg border border-border bg-panel p-1 shadow-float', className)}>
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}
export function MenuItem({ children, onSelect, icon, danger, disabled }: { children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel-hover',
        danger && 'text-danger',
      )}
    >
      {icon && <span className="text-subtle">{icon}</span>}
      {children}
    </RMenu.Item>
  );
}
export const MenuSeparator = () => <RMenu.Separator className="my-1 h-px bg-border" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <RMenu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">{children}</RMenu.Label>;

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={250}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-border bg-panel px-2 py-1 text-[12px] text-fg shadow-float">
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}

export function Tabs({ value, onValueChange, tabs, children, className }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode; count?: number }[]; children?: ReactNode; className?: string }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={className}>
      <RTabs.List className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2.5 py-2 text-[13px] text-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t.label}
            {t.count !== undefined && <span className="rounded bg-bg-subtle px-1 text-[11px] text-subtle">{t.count}</span>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}
export const TabPanel = RTabs.Content;

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-subtle p-0.5">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-2.5 py-1 text-[12.5px] transition-colors', value === o.value ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-left text-[13px]">{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cn('border-b border-border px-4 py-2 text-[11.5px] font-medium tracking-wide text-subtle uppercase', className)}>{children}</th>
);
export const Td = ({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => (
  <td colSpan={colSpan} className={cn('border-b border-border px-4 py-2.5 align-middle', className)}>
    {children}
  </td>
);
