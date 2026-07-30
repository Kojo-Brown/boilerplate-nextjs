"use client";

import { useSyncExternalStore } from "react";

// The value flips exactly once, when React hydrates, so there is no external
// store to subscribe to and nothing to unsubscribe from.
function subscribe(): () => void {
  return () => {};
}

const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * `false` while rendering on the server and during hydration, `true` afterwards.
 *
 * Use it to gate anything that needs a real DOM — portals in particular, since
 * `document` does not exist on the server. Modelling this as a server/client
 * snapshot difference rather than `setState` inside an effect avoids the
 * cascading re-render that `react-hooks/set-state-in-effect` warns about, and
 * keeps the server and first client render in agreement.
 */
export function useIsHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
