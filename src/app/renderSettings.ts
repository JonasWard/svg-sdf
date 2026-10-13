import { CurveMode, MetricSpec, toMetricSpec } from '../lib/types';
import { PRESETS } from '../render/presets';
import { DEFAULT_SETTINGS, PostSettings } from '../render/settings';
import { merge } from './files';
import { DEFAULT_COMPUTE } from './store';
import type { UrlSettings } from './urlSettings';

/** how a render is set up, the part of the render hook's options a playground link can carry */
export interface RenderSettingsOptions {
  width: number;
  /** margin around the svg, as a fraction of its larger side */
  padding?: number;
  curves?: CurveMode;
  metric?: Partial<MetricSpec>;
  /** a preset from src/render/presets.ts to start from, the default settings otherwise */
  preset?: string;
  /** deep overrides of the post settings */
  post?: unknown;
  /** a crop of the svg, which a link cannot carry: the link gets the default padding instead */
  region?: unknown;
  /** how closely polylines follow curves, in buffer px */
  tolerance?: number;
}

/** the colouring of a render: the preset with the overrides on top */
export const postSettings = (options: Pick<RenderSettingsOptions, 'preset' | 'post'>): PostSettings => {
  const base = options.preset ? PRESETS[options.preset] : DEFAULT_SETTINGS;
  if (!base) throw new Error(`unknown preset ${options.preset}`);
  return merge<PostSettings>(base, options.post);
};

/** the settings of a render as the playground keeps them, without a view so the playground fits its own svg */
export const toUrlSettings = (options: RenderSettingsOptions): UrlSettings => ({
  compute: {
    ...DEFAULT_COMPUTE,
    width: options.width,
    padding: options.region ? DEFAULT_COMPUTE.padding : Math.round((options.padding ?? 0.15) * 100),
    curves: options.curves ?? 'exact',
    metric: toMetricSpec(options.metric),
    tolerance: options.tolerance ?? DEFAULT_COMPUTE.tolerance
  },
  post: postSettings(options),
  view: null
});
