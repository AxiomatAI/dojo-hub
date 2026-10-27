import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from './api';
import i18n from './i18n';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === 'forbidden' && !err.message) return i18n.t('errors.forbidden');
    const details = Array.isArray(err.details)
      ? (err.details as { message?: string }[])
          .map((d) => d.message)
          .filter(Boolean)
          .slice(0, 3)
          .join('; ')
      : '';
    return details ? `${err.message}: ${details}` : err.message;
  }
  if (err instanceof TypeError) return i18n.t('errors.network');
  return (err as Error)?.message ?? i18n.t('common.error');
}

/** Mutation with toast on error and query invalidation on success. */
export function useAction<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: {
    invalidate?: unknown[][];
    success?: string | ((r: TResult) => string);
    onSuccess?: (r: TResult) => void;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}
