import { useEffect, useRef, useState } from 'react';
import { SdfRenderer } from '../render/renderer';
import { attachPanZoom, fitView } from '../view/panZoom';
import { useStore } from './store';

/** the live renderer, for exports */
export let activeRenderer: SdfRenderer | null = null;
/** css size of the canvas, for exports of the current view */
export const canvasSize = { width: 1, height: 1, dpr: 1 };

/** the part of the canvas not covered by the control panel, the panel sits on the left or, on phones, at the bottom */
const visibleRect = (canvas: HTMLCanvasElement) => {
  const c = canvas.getBoundingClientRect();
  const rect = { left: 0, top: 0, right: c.width, bottom: c.height };
  const panel = document.querySelector('.panel')?.getBoundingClientRect();
  if (!panel) return rect;
  if (panel.bottom >= c.bottom - 1 && panel.width >= c.width - 1) rect.bottom = panel.top - c.top;
  else if (panel.left - c.left < c.width / 2) rect.left = panel.right - c.left;
  return rect;
};

const fitTo = (canvas: HTMLCanvasElement) => {
  const { sdf, setView } = useStore.getState();
  if (sdf) setView(fitView(sdf.region, canvasSize.width, canvasSize.height, 1.05, visibleRect(canvas)));
};

export const SdfCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const sdf = useStore((s) => s.sdf);
  const post = useStore((s) => s.post);
  const view = useStore((s) => s.view);
  const fitRequest = useStore((s) => s.fitRequest);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: SdfRenderer;
    try {
      renderer = new SdfRenderer(canvas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    activeRenderer = renderer;
    const { sdf, post, view, setView } = useStore.getState();
    renderer.setSettings(post);
    renderer.setSdf(sdf);
    if (view) renderer.setView(view);

    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      canvasSize.width = rect.width;
      canvasSize.height = rect.height;
      canvasSize.dpr = window.devicePixelRatio || 1;
      renderer.resize(rect.width, rect.height, canvasSize.dpr);
    });
    observer.observe(canvas);
    const detach = attachPanZoom(
      canvas,
      () => useStore.getState().view ?? { cx: 0, cy: 0, scale: 1 },
      setView,
      () => fitTo(canvas)
    );
    return () => {
      detach();
      observer.disconnect();
      renderer.dispose();
      activeRenderer = null;
    };
  }, []);

  useEffect(() => activeRenderer?.setSdf(sdf), [sdf]);
  useEffect(() => activeRenderer?.setSettings(post), [post]);
  useEffect(() => {
    if (view) activeRenderer?.setView(view);
  }, [view]);

  // fit when a buffer for a newly loaded svg arrives, and on explicit requests
  useEffect(() => {
    const { fitOnNextSdf, setFitOnNextSdf } = useStore.getState();
    if (!sdf || !fitOnNextSdf) return;
    setFitOnNextSdf(false);
    fitTo(canvasRef.current!);
  }, [sdf]);
  useEffect(() => {
    if (fitRequest) fitTo(canvasRef.current!);
  }, [fitRequest]);

  return (
    <div className="canvas-wrap">
      <canvas ref={canvasRef} className="sdf-canvas" />
      {error && <div className="canvas-error">{error}</div>}
    </div>
  );
};
