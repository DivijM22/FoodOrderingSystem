import { useId, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { errorMessage } from '../api/client';
import { humanize } from '../format';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted loading" role="status">
      {label}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

const TONE: Record<string, string> = {
  delivered: 'ok', paid: 'ok', succeeded: 'ok', active: 'ok', available: 'ok', open: 'ok', confirmed: 'ok', issued: 'ok', veg: 'ok',
  pending_payment: 'warn', pending: 'warn', requires_action: 'warn', processing: 'warn', refund_pending: 'warn', busy: 'warn', partially_refunded: 'warn',
  cancelled: 'bad', expired: 'bad', failed: 'bad', refund_failed: 'bad', inactive: 'bad', closed: 'bad', offline: 'bad', 'non-veg': 'bad', assignment_failed: 'bad', unavailable: 'bad',
};

export function Badge({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return null;
  return <span className={`badge ${TONE[value] ?? ''}`}>{label ?? humanize(value)}</span>;
}

export function VegMark({ isVeg }: { isVeg: boolean }) {
  return (
    <span className={`veg ${isVeg ? 'is-veg' : 'non-veg'}`} title={isVeg ? 'Vegetarian' : 'Non-vegetarian'}>
      {isVeg ? 'Veg' : 'Non-veg'}
    </span>
  );
}

type FieldProps = { label: string; error?: string; hint?: string };

/** Label, control and its hint/error, linked for assistive technology (the label names only the control). */
function FieldShell({ label, error, hint, children }: FieldProps & { children: (ids: { id: string; describedBy?: string }) => ReactNode }) {
  const id = useId();
  const describedBy = [hint && !error ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy })}
      {hint && !error && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
      {error && (
        <small id={`${id}-error`} className="field-error">
          {error}
        </small>
      )}
    </div>
  );
}

export function Field({ label, error, hint, ...input }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy }) => <input id={id} {...input} aria-invalid={!!error} aria-describedby={describedBy} />}
    </FieldShell>
  );
}

export function SelectField({ label, error, hint, children, ...select }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy }) => (
        <select id={id} {...select} aria-invalid={!!error} aria-describedby={describedBy}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

export function TextArea({ label, error, hint, ...area }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {({ id, describedBy }) => <textarea id={id} {...area} aria-invalid={!!error} aria-describedby={describedBy} />}
    </FieldShell>
  );
}

/** Button that disables itself while its async handler runs. */
export function AsyncButton({ onClick, children, className = '', disabled, type = 'button' }: { onClick?: () => Promise<unknown> | void; children: ReactNode; className?: string; disabled?: boolean; type?: 'button' | 'submit' }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={type}
      className={className}
      disabled={disabled || busy}
      onClick={
        onClick
          ? async () => {
              setBusy(true);
              try {
                await onClick();
              } finally {
                setBusy(false);
              }
            }
          : undefined
      }
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

/** Minimal modal confirmation (native <dialog>). */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger, confirmDisabled, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Keeps the confirm button disabled, e.g. until an explicit acknowledgement is ticked. */
  confirmDisabled?: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="dialog-title">{title}</h3>
        <div className="dialog-body">{children}</div>
        <div className="actions">
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'danger' : ''}
            disabled={busy || confirmDisabled}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {children && <div className="page-header-actions">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty muted">{children}</p>;
}
