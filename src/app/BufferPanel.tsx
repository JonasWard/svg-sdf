import { activeRenderer } from './SdfCanvas';
import { MetricControls } from './MetricControls';
import { BackendPreference } from '../lib/gpu/computer';

const BACKEND_LABELS = { webgpu: 'WebGPU', webgl: 'WebGL2', cpu: 'CPU' } as const;
import { NumberField, Section, Segmented, Slider } from './controls';
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
      <label className="control stacked">
        <span className="label">Compute</span>
        <select value={compute.backend} onChange={(e) => setCompute({ backend: e.target.value as BackendPreference })}>
          <option value="auto">Auto (GPU, then CPU)</option>
          <option value="webgpu">WebGPU compute</option>
          <option value="webgl">WebGL2 offscreen</option>
          <option value="cpu">CPU (float64 reference)</option>
        </select>
      </label>
      <MetricControls metric={compute.metric} onChange={(metric) => setCompute({ metric })} />
      <div className="control stacked">
        <span className="label">Curves</span>
        <Segmented
          options={['exact', 'polyline'] as const}
          value={compute.curves}
          labels={{ exact: 'Exact', polyline: 'Polyline' }}
          onChange={(curves) => setCompute({ curves })}
        />
      </div>
      {compute.curves === 'polyline' && (
        <Slider
          label="Curve tolerance px"
          value={compute.tolerance}
          min={0.02}
          max={2}
          step={0.01}
          onChange={(tolerance) => setCompute({ tolerance })}
        />
      )}
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
                  (status.lines !== undefined ? ` · ${status.lines.toLocaleString()} lines` : '') +
                  (status.curves ? ` · ${status.curves.toLocaleString()} curves` : '') +
                  (status.ms !== undefined ? ` · ${Math.round(status.ms)} ms` : '') +
                  (status.backend ? ` · ${BACKEND_LABELS[status.backend]}` : '') +
                  (status.message ? ` · ${status.message}` : '')
                : ''}
        </span>
        {status.state === 'done' && status.notes?.length ? (
          <p className="hint">Fell back: {status.notes.join('; ')}</p>
        ) : null}
      </div>
    </Section>
  );
};
