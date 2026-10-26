/** Multi-select as a list of checkboxes (clearer than <select multiple>). */
export function CheckList({ options, selected, onChange, empty = 'Nothing to choose from.' }: {
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  empty?: string;
}) {
  if (!options.length) return <p className="muted small-print">{empty}</p>;
  return (
    <div className="checklist">
      {options.map((o) => (
        <label key={o.value} className="checkbox">
          <input
            type="checkbox"
            checked={selected.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
          />
          <span>
            {o.label}
            {o.hint && <span className="muted small-print"> · {o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
