/** Window and display bounds use the same logical desktop coordinates. */
type Bounds = chrome.system.display.Bounds;
type WindowBounds = Pick<chrome.windows.Window, 'left' | 'top' | 'width' | 'height'>;

function hasUsableBounds(bounds: WindowBounds | undefined): bounds is Bounds {
  return !!bounds
    && Number.isFinite(bounds.left) && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    && bounds.width! >= 1 && bounds.height! >= 1;
}

export function selectWindowWorkArea(
  displays: chrome.system.display.DisplayUnitInfo[],
  reference?: WindowBounds,
): Bounds | null {
  const usable = displays.filter(display => display.isEnabled
    && display.activeState !== 'inactive' && hasUsableBounds(display.workArea));
  if (usable.length === 0) return null;

  let selected = usable.find(display => display.isPrimary) ?? usable[0];
  let largestIntersection = 0;
  if (hasUsableBounds(reference)) {
    for (const display of usable) {
      const area = display.workArea;
      const width = Math.max(0, Math.min(reference.left + reference.width, area.left + area.width) - Math.max(reference.left, area.left));
      const height = Math.max(0, Math.min(reference.top + reference.height, area.top + area.height) - Math.max(reference.top, area.top));
      const intersection = width * height;
      if (intersection > largestIntersection) {
        largestIntersection = intersection;
        selected = display;
      }
    }
  }
  return selected.workArea;
}

export function createOwnedWindowBounds(area: Bounds): Bounds {
  return {
    left: area.left,
    top: area.top,
    width: Math.min(1280, area.width),
    height: Math.min(900, area.height),
  };
}

/** Preserve a user's smaller size and valid position; only repair overflow. */
export function constrainOwnedWindowBounds(window: WindowBounds, area: Bounds): Bounds | null {
  if (!hasUsableBounds(window)) return null;
  const width = Math.min(window.width, area.width);
  const height = Math.min(window.height, area.height);
  const left = Math.min(Math.max(window.left, area.left), area.left + area.width - width);
  const top = Math.min(Math.max(window.top, area.top), area.top + area.height - height);
  if (width === window.width && height === window.height && left === window.left && top === window.top) return null;
  return { left, top, width, height };
}
