import { DEFAULT_METRIC, MetricKind, MetricSpec } from '../lib/types';
import { Slider } from './controls';

const KINDS: { kind: MetricKind; label: string }[] = [
  { kind: 'euclidean', label: 'Euclidean (circle)' },
  { kind: 'manhattan', label: 'Manhattan (diamond)' },
  { kind: 'chebyshev', label: 'Chebyshev (square)' },
  { kind: 'lp', label: 'Lp (circle ↔ square)' },
  { kind: 'polygon', label: 'Polygon (n-gon)' }
];

/** the unit shape of the distance: its kind, the kind's parameter, and a rotation and stretch for every kind */
export const MetricControls = ({ metric, onChange }: { metric: MetricSpec; onChange: (m: MetricSpec) => void }) => {
  const set = (patch: Partial<MetricSpec>) => onChange({ ...metric, ...patch });
  const transformed = metric.angle !== 0 || metric.aspect !== 1;
  return (
    <>
      <label className="control stacked">
        <span className="label">Metric</span>
        <select value={metric.kind} onChange={(e) => set({ kind: e.target.value as MetricKind })}>
          {KINDS.map(({ kind, label }) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {metric.kind === 'lp' && (
        <>
          <Slider label="p" value={metric.p} min={1.05} max={16} step={0.05} onChange={(p) => set({ p })} />
          <p className="hint">1 is Manhattan, 2 Euclidean, and higher values approach Chebyshev.</p>
        </>
      )}
      {metric.kind === 'polygon' && (
        <Slider label="Sides" value={metric.sides} min={3} max={12} step={1} onChange={(sides) => set({ sides })} />
      )}
      <Slider label="Angle °" value={metric.angle} min={0} max={180} step={1} onChange={(angle) => set({ angle })} />
      <Slider
        label="Stretch"
        value={Math.log2(metric.aspect)}
        min={-2}
        max={2}
        step={0.05}
        onChange={(v) => set({ aspect: Math.abs(v) < 0.025 ? 1 : 2 ** v })}
        format={(v) => `×${(2 ** v).toFixed(2)}`}
      />
      {transformed && (
        <div className="button-row">
          <button className="small" onClick={() => set({ angle: DEFAULT_METRIC.angle, aspect: DEFAULT_METRIC.aspect })}>
            Reset angle & stretch
          </button>
        </div>
      )}
    </>
  );
};
