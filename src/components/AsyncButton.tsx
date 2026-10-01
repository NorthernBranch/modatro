import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export function AsyncButton({
  pending = false,
  pendingLabel = 'Working…',
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean; pendingLabel?: string }) {
  return (
    <button {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? (
        <>
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
