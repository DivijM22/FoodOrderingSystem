/** Integer paise → "₹249.00". */
export const rupees = (paise: number | null | undefined) =>
  typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
/** "249.5" (rupees typed by a user) → 24950 paise. */
export const toPaise = (rupeesText: string) => Math.round(Number(rupeesText) * 100);
export const dateTime = (t: string | Date | null | undefined) => (t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const time = (t: string | Date | null | undefined) => (t ? new Date(t).toLocaleTimeString('en-IN', { timeStyle: 'short' }) : '—');
export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');
