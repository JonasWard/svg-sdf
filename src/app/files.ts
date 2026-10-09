import { decodeSdf } from '../lib/io/sdfFile';
import { DEFAULT_SETTINGS, PostSettings, View } from '../render/settings';
import { ComputeSettings, DEFAULT_COMPUTE, useStore } from './store';

export const download = (data: Blob, name: string) => {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const baseName = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '-')
    .toLowerCase() || 'sdf';

export interface SettingsFile {
  compute: ComputeSettings;
  post: PostSettings;
  view: View | null;
}

/** deep merge onto defaults, so settings files from older versions still load */
const merge = <T>(base: T, patch: unknown): T => {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
};

export const settingsToJson = (): string => {
  const { compute, post, view } = useStore.getState();
  return JSON.stringify({ compute, post, view } satisfies SettingsFile, null, 2);
};

export const applySettingsJson = (text: string) => {
  const parsed = JSON.parse(text) as Partial<SettingsFile>;
  const { setPost, setCompute, setView } = useStore.getState();
  setPost(merge(DEFAULT_SETTINGS, parsed.post));
  setCompute(merge(DEFAULT_COMPUTE, parsed.compute));
  if (parsed.view && Number.isFinite(parsed.view.scale)) setView(parsed.view);
};

/** opens an .svg (recomputed), .sdf (shown as is) or settings .json file */
export const openFile = async (file: File) => {
  const store = useStore.getState();
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.sdf')) {
      const sdf = decodeSdf(await file.arrayBuffer());
      store.setFitOnNextSdf(true);
      store.setSdf(sdf);
      store.setStatus({ state: 'done', progress: 1, message: `loaded ${file.name}` });
    } else if (name.endsWith('.json')) {
      applySettingsJson(await file.text());
    } else {
      store.setSvg(file.name.replace(/\.svg$/i, ''), await file.text());
    }
  } catch (e) {
    store.setStatus({ state: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) });
  }
};
