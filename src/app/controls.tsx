import { ReactNode } from 'react';
import { RampStop } from '../render/settings';

export const Section = ({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) => (
  <section className="section">
    <header>
      <h2>{title}</h2>
      {aside}
    </header>
    {children}
  </section>
);

export const Slider = ({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format = (v) => String(Math.round(v * 100) / 100)
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) => (
  <label className="control slider">
    <span className="label">{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
    <span className="value">{format(value)}</span>
  </label>
);

export const NumberField = ({
  label,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) => (
  <label className="control">
    <span className="label">{label}</span>
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
    />
  </label>
);

export const ColorField = ({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) => (
  <label className="control color">
    <span className="label">{label}</span>
    <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    <span className="value">{value}</span>
  </label>
);

export const Toggle = ({
  label,
  value,
  onChange
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label className="control toggle">
    <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    <span className="label">{label}</span>
  </label>
);

export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  labels
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
}) => (
  <div className="segmented" role="radiogroup">
    {options.map((o) => (
      <button
        key={o}
        role="radio"
        aria-checked={o === value}
        className={o === value ? 'active' : ''}
        onClick={() => onChange(o)}
      >
        {labels?.[o] ?? o}
      </button>
    ))}
  </div>
);

const rampCss = (stops: RampStop[]) =>
  `linear-gradient(to right, ${[...stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${s.pos * 100}%`)
    .join(', ')})`;

/** colour stops of a ramp: colour, position, remove; plus a preview strip and an add button */
export const RampEditor = ({
  label,
  stops,
  onChange
}: {
  label: string;
  stops: RampStop[];
  onChange: (s: RampStop[]) => void;
}) => (
  <div className="ramp">
    <div className="ramp-head">
      <span className="label">{label}</span>
      <button
        className="small"
        onClick={() => {
          const sorted = [...stops].sort((a, b) => a.pos - b.pos);
          // add halfway into the widest gap
          let best = 0;
          for (let i = 1; i < sorted.length - 1; i++)
            if (sorted[i + 1].pos - sorted[i].pos > sorted[best + 1].pos - sorted[best].pos) best = i;
          const pos = sorted.length > 1 ? (sorted[best].pos + sorted[best + 1].pos) / 2 : 0.5;
          onChange([...stops, { pos, color: sorted[best]?.color ?? '#808080' }]);
        }}
      >
        + stop
      </button>
    </div>
    <div className="ramp-preview" style={{ background: rampCss(stops) }} />
    {stops.map((stop, i) => (
      <div className="ramp-stop" key={i}>
        <input
          type="color"
          value={stop.color}
          onChange={(e) => onChange(stops.map((s, j) => (j === i ? { ...s, color: e.target.value } : s)))}
        />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={stop.pos}
          onChange={(e) => onChange(stops.map((s, j) => (j === i ? { ...s, pos: Number(e.target.value) } : s)))}
        />
        <button
          className="small"
          disabled={stops.length < 2}
          onClick={() => onChange(stops.filter((_, j) => j !== i))}
          aria-label="remove stop"
        >
          ×
        </button>
      </div>
    ))}
  </div>
);
