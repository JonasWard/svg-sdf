import { useEffect, useState } from 'react';
import { BufferPanel } from './BufferPanel';
import { ExportPanel } from './ExportPanel';
import { openFile } from './files';
import { PostPanel } from './PostPanel';
import { SdfCanvas } from './SdfCanvas';
import { SourcePanel } from './SourcePanel';
import { useStore } from './store';
import { useSdfComputation } from './useSdfComputation';

export const App = () => {
  useSdfComputation();
  const [panelOpen, setPanelOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const requestFit = useStore((s) => s.requestFit);

  // files can be dropped anywhere on the page
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) openFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className={`app ${panelOpen ? 'panel-open' : ''}`}>
      <SdfCanvas />
      <div className="toolbar">
        <button onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
          {panelOpen ? 'Hide controls' : 'Controls'}
        </button>
        <button onClick={requestFit} title="or double click the canvas">
          Fit
        </button>
      </div>
      {panelOpen && (
        <aside className="panel">
          <h1>
            svg <span className="muted">→</span> sdf
          </h1>
          <SourcePanel />
          <BufferPanel />
          <PostPanel />
          <ExportPanel />
          <p className="hint">Drag to pan, scroll or pinch to zoom, double click to fit.</p>
        </aside>
      )}
      {dragging && <div className="drop-overlay">Drop an .svg, .sdf or settings .json</div>}
    </div>
  );
};
