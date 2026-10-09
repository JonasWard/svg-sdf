import { useRef, useState } from 'react';
import { SAMPLES } from '../samples';
import { Section } from './controls';
import { openFile } from './files';
import { useStore } from './store';

export const SourcePanel = () => {
  const svgName = useStore((s) => s.svgName);
  const setSvg = useStore((s) => s.setSvg);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState('');

  return (
    <Section title="SVG" aside={<span className="muted">{svgName}</span>}>
      <div className="button-row">
        {SAMPLES.map((s) => (
          <button key={s.name} className={s.name === svgName ? 'active' : ''} onClick={() => setSvg(s.name, s.svg)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="button-row">
        <button onClick={() => fileRef.current?.click()}>Open file…</button>
        <button onClick={() => setPasting((p) => !p)}>{pasting ? 'Cancel' : 'Paste SVG'}</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".svg,.sdf,.json,image/svg+xml"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) openFile(file);
          e.target.value = '';
        }}
      />
      {pasting && (
        <div className="paste">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="<svg …>…</svg>" rows={6} />
          <button
            disabled={!draft.trim()}
            onClick={() => {
              setSvg('pasted', draft);
              setPasting(false);
              setDraft('');
            }}
          >
            Use
          </button>
        </div>
      )}
      <p className="hint">Or drop an .svg, .sdf or settings .json anywhere.</p>
    </Section>
  );
};
