import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * One rule above the Contacts table, as a pill: "Label Value ▾".
 *
 * Dashed when unset ("Any"), brand-tinted when set. Clicking opens a small
 * menu of checkboxes (or radio-like rows for a single choice). An outside
 * click or Escape closes it.
 */

export interface RuleOption {
  value: string;
  label: string;
  /** A pill class (e.g. `pill-paying`) to render the label as a pill. */
  pill?: string;
  count?: number | null;
  hint?: string;
}

export function RuleButton({
  label,
  value,
  isSet,
  heading,
  options,
  selected,
  multiple = true,
  onChange,
  footer,
}: {
  label: string;
  value: string;
  isSet: boolean;
  heading: string;
  options: RuleOption[];
  selected: string[];
  multiple?: boolean;
  onChange: (next: string[]) => void;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (option: string) => {
    if (!multiple) {
      onChange([option]);
      setOpen(false);
      return;
    }
    onChange(
      selected.includes(option)
        ? selected.filter((value) => value !== option)
        : [...selected, option],
    );
  };

  const classes = ['cv-filter'];
  if (isSet) classes.push('is-set');
  if (open) classes.push('is-open');

  return (
    <span className="cv-filter-wrap" ref={wrap}>
      <button
        type="button"
        className={classes.join(' ')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="cv-filter-k">{label}</span>
        <span className="cv-filter-v">{value}</span>
        <svg className="aud-caret" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M6 8l5 5 5-5" fill="none" strokeWidth="1.8" />
        </svg>
      </button>
      {open ? (
        <div className="cv-menu" role="menu">
          <div className="cv-menu-head">{heading}</div>
          <ul>
            {options.map((option) => {
              const on = selected.includes(option.value);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role={multiple ? 'menuitemcheckbox' : 'menuitemradio'}
                    aria-checked={on}
                    className="cv-menu-row"
                    title={option.hint}
                    onClick={() => toggle(option.value)}
                  >
                    <span
                      className={`check-box${multiple ? '' : ' is-radio'}${on ? ' is-on' : ''}`}
                      aria-hidden="true"
                    />
                    {option.pill ? (
                      <span className={`pill ${option.pill}`}>{option.label}</span>
                    ) : (
                      <span className="cv-menu-label">{option.label}</span>
                    )}
                    <span className="check-count">
                      {option.count === undefined || option.count === null
                        ? ''
                        : option.count.toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {footer ? <div className="cv-menu-foot">{footer}</div> : null}
        </div>
      ) : null}
    </span>
  );
}
