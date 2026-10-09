import { activeRenderer } from './SdfCanvas';
import { NumberField, Section, Slider } from './controls';
import { useStore } from './store';

const RESOLUTIONS = [256, 512, 1024, 2048, 4096];

export const BufferPanel = () => {
  const compute = useStore((s) => s.compute);
  const setCompute = useStore((s) => s.setCompute);
  const status = useStore((s) => s.status);
  const sdf = useStore((s) => s.sdf);
  const maxWidth = Math.min(8192, activeRenderer?.maxTextureSize ?? 4096);

  return (
    <Section title="Distance buffer">
      <div className="button-row">
        {RESOLUTIONS.filter((r) => r <= maxWidth).map((r) => (
          <button key={r} className={r === compute.width ? 'active' : ''} onClick={() => setCompute({ width: r })}>
            {r}
          </button>
        ))}
      </div>
      <NumberField
        label="Width px"
        value={compute.width}
        min={16}
        max={maxWidth}
        onChange={(width) => setCompute({ width })}
      />
      <Slider
        label="Padding %"
        value={compute.padding}
        min={0}
        max={100}
        step={1}
        onChange={(padding) => setCompute({ padding })}
      />
      <Slider
        label="Curve tolerance px"
        value={compute.tolerance}
        min={0.02}
        max={2}
        step={0.01}
        onChange={(tolerance) => setCompute({ tolerance })}
      />
      <div className={`status ${status.state}`}>
        {status.state === 'computing' && (
          <div className="progress">
            <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
          </div>
        )}
        <span>
          {status.state === 'error'
            ? status.message
            : status.state === 'computing'
              ? `computing… ${Math.round(status.progress * 100)}%`
              : sdf
                ? `${sdf.width} × ${sdf.height}` +
                  (status.segments !== undefined ? ` · ${status.segments.toLocaleString()} segments` : '') +
                  (status.ms !== undefined ? ` · ${Math.round(status.ms)} ms` : '') +
                  (status.message ? ` · ${status.message}` : '')
                : ''}
        </span>
      </div>
    </Section>
  );
};
