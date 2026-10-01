import { useCallback, useRef, useState } from 'react';
import type { AppError, Reply } from '../shared/model';

interface RequestOptions {
  group?: string;
  failureMessage?: string;
}
export interface Requests {
  pending: Record<string, { label: string; group?: string }>;
  isPending: (key: string) => boolean;
  isBusy: (group: string) => boolean;
  run: <T>(
    key: string,
    label: string,
    task: () => Promise<Reply<T>>,
    options?: RequestOptions,
  ) => Promise<Reply<T> | undefined>;
}

export function useRequests(reportError: (error: AppError) => void): Requests {
  const active = useRef<Requests['pending']>({});
  const [pending, setPending] = useState<Requests['pending']>({});
  const run = useCallback<Requests['run']>(
    async (key, label, task, options = {}) => {
      // Refs guard even clicks arriving before React has disabled the controls.
      if (
        active.current[key] ||
        (options.group &&
          Object.values(active.current).some((request) => request.group === options.group))
      )
        return undefined;
      active.current = { ...active.current, [key]: { label, group: options.group } };
      setPending(active.current);
      try {
        const reply = await task();
        if (!reply.ok) reportError(reply.error);
        return reply;
      } catch (error) {
        const reply: Reply<never> = {
          ok: false,
          error: {
            message: options.failureMessage ?? `${label} failed. Try again.`,
            details: error instanceof Error ? error.message : String(error),
          },
        };
        reportError(reply.error);
        return reply;
      } finally {
        const remaining = { ...active.current };
        delete remaining[key];
        active.current = remaining;
        setPending(remaining);
      }
    },
    [reportError],
  );
  return {
    pending,
    isPending: (key) => !!pending[key],
    isBusy: (group) => Object.values(pending).some((request) => request.group === group),
    run,
  };
}
