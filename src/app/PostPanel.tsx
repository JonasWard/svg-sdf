import { CYCLIC_GRADIENTS, PRESETS } from '../render/presets';
import { MODES, POLAR_PALETTES, PolarSide, PostSettings } from '../render/settings';
import { ColorField, RampEditor, Section, Segmented, Slider, Toggle } from './controls';
import { useStore } from './store';

const MODE_LABELS = { polar: 'Polar', ramp: 'Ramps', shape: 'Shapes', grayscale: 'Raw' } as const;

/** a setter for one nested group of the settings */
const useGroup = <K extends keyof PostSettings>(key: K) => {
  const value = useStore((s) => s.post[key]);
  const updatePost = useStore((s) => s.updatePost);
  const set = (patch: Partial<PostSettings[K]>) =>
    updatePost((p) => ({ ...p, [key]: { ...(p[key] as object), ...patch } }));
  return [value, set] as const;
};

const PALETTE_LABELS = { hsv: 'HSV', oklch: 'OKLCH', gradient: 'Gradient' } as const;

const PolarSideControls = ({
  title,
  side,
  perceptual,
  onChange
}: {
  title: string;
  side: PolarSide;
  /** oklch reads the sliders as chroma and lightness */
  perceptual: boolean;
  onChange: (s: PolarSide) => void;
}) => {
  const sat = perceptual ? 'Chroma' : 'Saturation';
  const val = perceptual ? 'Lightness' : 'Value';
  return (
    <>
      <h3>{title}</h3>
      <Slider
        label={`${sat} near`}
        value={side.satNear}
        min={0}
        max={1}
        onChange={(satNear) => onChange({ ...side, satNear })}
      />
      <Slider
        label={`${sat} far`}
        value={side.satFar}
        min={0}
        max={1}
        onChange={(satFar) => onChange({ ...side, satFar })}
      />
      <Slider
        label={`${val} near`}
        value={side.valNear}
        min={0}
        max={1}
        onChange={(valNear) => onChange({ ...side, valNear })}
      />
      <Slider
        label={`${val} far`}
        value={side.valFar}
        min={0}
        max={1}
        onChange={(valFar) => onChange({ ...side, valFar })}
      />
    </>
  );
};

export const PostPanel = () => {
  const post = useStore((s) => s.post);
  const setPost = useStore((s) => s.setPost);
  const updatePost = useStore((s) => s.updatePost);
  const [ramp, setRamp] = useGroup('ramp');
  const [polar, setPolar] = useGroup('polar');
  const [shape, setShape] = useGroup('shape');
  const [grayscale, setGrayscale] = useGroup('grayscale');
  const [contours, setContours] = useGroup('contours');
  const [outline, setOutline] = useGroup('outline');

  return (
    <>
      <Section
        title="Colouring"
        aside={
          <select value="" onChange={(e) => e.target.value && setPost(PRESETS[e.target.value])} aria-label="presets">
            <option value="">Presets…</option>
            {Object.keys(PRESETS).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        }
      >
        <Segmented
          options={MODES}
          value={post.mode}
          labels={MODE_LABELS}
          onChange={(mode) => updatePost((p) => ({ ...p, mode }))}
        />
        <ColorField
          label="Background"
          value={post.background}
          onChange={(background) => updatePost((p) => ({ ...p, background }))}
        />

        {post.mode === 'polar' && (
          <>
            <p className="hint">
              Hue follows the direction to the nearest edge, the near/far settings follow the distance.
            </p>
            <Segmented
              options={POLAR_PALETTES}
              value={polar.palette}
              labels={PALETTE_LABELS}
              onChange={(palette) => setPolar({ palette })}
            />
            {polar.palette === 'oklch' && (
              <p className="hint">
                A perceptual hue wheel: every hue at the same lightness, no bright yellow or cyan bands.
              </p>
            )}
            {polar.palette === 'gradient' && (
              <>
                <select
                  value=""
                  onChange={(e) => e.target.value && setPolar({ stops: CYCLIC_GRADIENTS[e.target.value] })}
                  aria-label="cyclic gradients"
                >
                  <option value="">Gradient presets…</option>
                  {Object.keys(CYCLIC_GRADIENTS).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <RampEditor
                  label="Cyclic stops (wrap around)"
                  stops={polar.stops}
                  onChange={(stops) => setPolar({ stops })}
                />
              </>
            )}
            <Slider
              label="Hue repetitions"
              value={polar.repetitions}
              min={1}
              max={8}
              step={1}
              onChange={(repetitions) => setPolar({ repetitions })}
            />
            <Slider
              label="Hue offset"
              value={polar.hueOffset}
              min={0}
              max={1}
              onChange={(hueOffset) => setPolar({ hueOffset })}
            />
            <Slider
              label="Falloff %"
              value={polar.range}
              min={1}
              max={100}
              step={0.5}
              onChange={(range) => setPolar({ range })}
            />
            <Slider
              label="Radial lines"
              value={polar.radialLines}
              min={0}
              max={180}
              step={1}
              onChange={(radialLines) => setPolar({ radialLines })}
            />
            {polar.radialLines > 0 && (
              <Slider
                label="Radial width px"
                value={polar.radialWidth}
                min={0.5}
                max={6}
                step={0.1}
                onChange={(radialWidth) => setPolar({ radialWidth })}
              />
            )}
            <PolarSideControls
              title="Outside"
              side={polar.outside}
              perceptual={polar.palette === 'oklch'}
              onChange={(outside) => setPolar({ outside })}
            />
            <PolarSideControls
              title="Inside"
              side={polar.inside}
              perceptual={polar.palette === 'oklch'}
              onChange={(inside) => setPolar({ inside })}
            />
            <h3>Tiles</h3>
            <p className="hint">Cuts the direction × distance plane into tiles.</p>
            <Toggle
              label="Tiles"
              value={polar.tiles.enabled}
              onChange={(enabled) => setPolar({ tiles: { ...polar.tiles, enabled } })}
            />
            {polar.tiles.enabled && (
              <>
                <Segmented
                  options={['checker', 'mosaic'] as const}
                  value={polar.tiles.style}
                  labels={{ checker: 'Checker', mosaic: 'Mosaic' }}
                  onChange={(style) => setPolar({ tiles: { ...polar.tiles, style } })}
                />
                <Slider
                  label="Angle bands"
                  value={polar.tiles.angleBands}
                  min={2}
                  max={96}
                  step={1}
                  onChange={(angleBands) => setPolar({ tiles: { ...polar.tiles, angleBands } })}
                />
                <Slider
                  label="Distance spacing %"
                  value={polar.tiles.distanceSpacing}
                  min={0.2}
                  max={20}
                  step={0.1}
                  onChange={(distanceSpacing) => setPolar({ tiles: { ...polar.tiles, distanceSpacing } })}
                />
                {polar.tiles.style === 'checker' && (
                  <Slider
                    label="Contrast"
                    value={polar.tiles.contrast}
                    min={0}
                    max={1}
                    onChange={(contrast) => setPolar({ tiles: { ...polar.tiles, contrast } })}
                  />
                )}
              </>
            )}
          </>
        )}

        {post.mode === 'ramp' && (
          <>
            <RampEditor label="Inside" stops={ramp.inside} onChange={(inside) => setRamp({ inside })} />
            <Slider
              label="Inside range %"
              value={ramp.rangeInside}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(rangeInside) => setRamp({ rangeInside })}
            />
            <RampEditor label="Outside" stops={ramp.outside} onChange={(outside) => setRamp({ outside })} />
            <Slider
              label="Outside range %"
              value={ramp.rangeOutside}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(rangeOutside) => setRamp({ rangeOutside })}
            />
            <Toggle label="Repeat ramps" value={ramp.repeat} onChange={(repeat) => setRamp({ repeat })} />
          </>
        )}

        {post.mode === 'shape' && (
          <>
            <p className="hint">Each pixel takes the colour of its svg shape, outside the one with the nearest edge.</p>
            <Slider
              label="Falloff %"
              value={shape.range}
              min={1}
              max={100}
              step={0.5}
              onChange={(range) => setShape({ range })}
            />
            <Slider
              label="Shade inside"
              value={shape.shadeInside}
              min={0}
              max={1}
              onChange={(shadeInside) => setShape({ shadeInside })}
            />
            <Slider
              label="Fade outside"
              value={shape.fadeOutside}
              min={0}
              max={1}
              onChange={(fadeOutside) => setShape({ fadeOutside })}
            />
          </>
        )}

        {post.mode === 'grayscale' && (
          <>
            <p className="hint">The raw field: mid grey on the edge, black inside, white outside.</p>
            <Slider
              label="Range %"
              value={grayscale.range}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(range) => setGrayscale({ range })}
            />
          </>
        )}
      </Section>

      <Section
        title="Contours"
        aside={<Toggle label="" value={contours.enabled} onChange={(enabled) => setContours({ enabled })} />}
      >
        {contours.enabled && (
          <>
            <Segmented
              options={['lines', 'bands'] as const}
              value={contours.style}
              onChange={(style) => setContours({ style })}
            />
            <Slider
              label="Spacing %"
              value={contours.spacing}
              min={0.1}
              max={20}
              step={0.05}
              onChange={(spacing) => setContours({ spacing })}
            />
            <Slider
              label="Offset %"
              value={contours.offset}
              min={0}
              max={20}
              step={0.05}
              onChange={(offset) => setContours({ offset })}
            />
            {contours.style === 'lines' && (
              <Slider
                label="Width px"
                value={contours.width}
                min={0.25}
                max={10}
                step={0.05}
                onChange={(width) => setContours({ width })}
              />
            )}
            <ColorField label="Colour" value={contours.color} onChange={(color) => setContours({ color })} />
            <Slider
              label="Opacity"
              value={contours.opacity}
              min={0}
              max={1}
              onChange={(opacity) => setContours({ opacity })}
            />
            <div className="button-row">
              <Toggle label="Inside" value={contours.inside} onChange={(inside) => setContours({ inside })} />
              <Toggle label="Outside" value={contours.outside} onChange={(outside) => setContours({ outside })} />
            </div>
          </>
        )}
      </Section>

      <Section
        title="Outline"
        aside={<Toggle label="" value={outline.enabled} onChange={(enabled) => setOutline({ enabled })} />}
      >
        {outline.enabled && (
          <>
            <Slider
              label="Width px"
              value={outline.width}
              min={0.5}
              max={20}
              step={0.25}
              onChange={(width) => setOutline({ width })}
            />
            <ColorField label="Colour" value={outline.color} onChange={(color) => setOutline({ color })} />
          </>
        )}
      </Section>
    </>
  );
};
