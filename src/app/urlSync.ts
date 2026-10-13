import { useStore } from './store';
import { decodeSettings, encodeSettings, toRelativeView } from './urlSettings';

const PARAM = 's';
const DEBOUNCE_MS = 250;

const writeUrl = () => {
  const { compute, post, view, sdf, pendingView } = useStore.getState();
  // until the first buffer has placed it, the view from the url is still the one to keep
  const relative = pendingView ?? (view && sdf ? toRelativeView(view, sdf.region, sdf.pixelSize) : null);
  const params = new URLSearchParams(location.search);
  params.set(PARAM, encodeSettings({ compute, post, view: relative }));
  history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
};

/** loads the settings and view from the url, then keeps the url up to date with them */
export const installUrlSync = () => {
  const text = new URLSearchParams(location.search).get(PARAM);
  const settings = text ? decodeSettings(text) : null;
  if (settings) useStore.setState({ compute: settings.compute, post: settings.post, pendingView: settings.view });
  else if (text) console.warn('ignoring settings in the url that cannot be read');

  let timer: ReturnType<typeof setTimeout> | undefined;
  useStore.subscribe((s, prev) => {
    if (s.compute === prev.compute && s.post === prev.post && s.view === prev.view && s.sdf === prev.sdf) return;
    clearTimeout(timer);
    timer = setTimeout(writeUrl, DEBOUNCE_MS);
  });
};
