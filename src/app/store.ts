import { create } from 'zustand';
import { SdfBuffer } from '../lib/types';
import { DEFAULT_SETTINGS, PostSettings, View } from '../render/settings';
import { SAMPLES } from '../samples';

export interface ComputeSettings {
  /** buffer width in px */
  width: number;
  /** margin around the svg, percent of its larger side */
  padding: number;
  /** curve flattening tolerance in buffer px */
  tolerance: number;
}

export interface Status {
  state: 'idle' | 'computing' | 'done' | 'error';
  progress: number;
  message?: string;
  ms?: number;
  segments?: number;
}

interface State {
  svgName: string;
  svgText: string;
  compute: ComputeSettings;
  status: Status;
  sdf: SdfBuffer | null;
  post: PostSettings;
  view: View | null;
  /** bumped to ask the canvas to fit the view to the current buffer */
  fitRequest: number;
  /** fit the view once the next buffer arrives, set when a new svg is loaded */
  fitOnNextSdf: boolean;

  setSvg: (name: string, text: string) => void;
  setCompute: (patch: Partial<ComputeSettings>) => void;
  setStatus: (status: Status) => void;
  setSdf: (sdf: SdfBuffer | null) => void;
  setPost: (post: PostSettings) => void;
  updatePost: (update: (post: PostSettings) => PostSettings) => void;
  setView: (view: View) => void;
  requestFit: () => void;
  setFitOnNextSdf: (fit: boolean) => void;
}

export const DEFAULT_COMPUTE: ComputeSettings = { width: 1024, padding: 15, tolerance: 0.25 };

export const useStore = create<State>((set) => ({
  svgName: SAMPLES[0].name,
  svgText: SAMPLES[0].svg,
  compute: DEFAULT_COMPUTE,
  status: { state: 'idle', progress: 0 },
  sdf: null,
  post: DEFAULT_SETTINGS,
  view: null,
  fitRequest: 0,
  fitOnNextSdf: true,

  setSvg: (svgName, svgText) => set({ svgName, svgText, fitOnNextSdf: true }),
  setCompute: (patch) => set((s) => ({ compute: { ...s.compute, ...patch } })),
  setStatus: (status) => set({ status }),
  setSdf: (sdf) => set({ sdf }),
  setPost: (post) => set({ post }),
  updatePost: (update) => set((s) => ({ post: update(s.post) })),
  setView: (view) => set({ view }),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
  setFitOnNextSdf: (fitOnNextSdf) => set({ fitOnNextSdf })
}));
