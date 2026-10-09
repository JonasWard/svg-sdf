import { useRef, useState } from 'react';
import { encodeSdf } from '../lib/io/sdfFile';
import { activeRenderer, canvasSize } from './SdfCanvas';
import { Section, Slider } from './controls';
import { applySettingsJson, baseName, download, settingsToJson } from './files';
import { useStore } from './store';

export const ExportPanel = () => {
  const sdf = useStore((s) => s.sdf);
  const svgName = useStore((s) => s.svgName);
  const [scale, setScale] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const settingsRef = useRef<HTMLInputElement>(null);
  const name = baseName(svgName);

  const run = async (task: () => Promise<void> | void) => {
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title="Export">
      <div className="button-row">
        <button disabled={!sdf} onClick={() => run(() => download(new Blob([encodeSdf(sdf!)]), `${name}.sdf`))}>
          Buffer .sdf
        </button>
        <button
          disabled={!sdf || !activeRenderer}
          onClick={() =>
            run(async () => {
              const { width, height, dpr } = canvasSize;
              const view = useStore.getState().view!;
              const blob = await activeRenderer!.renderImage(
                Math.round(width * dpr),
                Math.round(height * dpr),
                view,
                dpr
              );
              download(blob, `${name}-view.png`);
            })
          }
        >
          PNG of view
        </button>
      </div>
      <div className="button-row">
        <button
          disabled={!sdf || !activeRenderer}
          onClick={() =>
            run(async () => {
              const s = sdf!;
              const view = {
                cx: (s.region.minX + s.region.maxX) / 2,
                cy: (s.region.minY + s.region.maxY) / 2,
                scale: s.pixelSize / scale
              };
              // line widths scale with the export so the full image looks like the screen at the same zoom
              const blob = await activeRenderer!.renderImage(s.width * scale, s.height * scale, view, scale);
              download(blob, `${name}-${s.width * scale}.png`);
            })
          }
        >
          PNG of whole buffer
        </button>
      </div>
      <Slider
        label="Buffer PNG scale"
        value={scale}
        min={1}
        max={4}
        step={1}
        onChange={setScale}
        format={(v) => `×${v}`}
      />
      <div className="button-row">
        <button
          onClick={() => download(new Blob([settingsToJson()], { type: 'application/json' }), `${name}-settings.json`)}
        >
          Save settings
        </button>
        <button onClick={() => settingsRef.current?.click()}>Load settings</button>
      </div>
      <input
        ref={settingsRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) run(async () => applySettingsJson(await file.text()));
        }}
      />
      {error && <p className="error">{error}</p>}
    </Section>
  );
};
