"use client";

import { useSyncExternalStore } from "react";

// Revola's media-query hook, made synchronous: the upstream version starts at `null` and settles
// in an effect, so a dialog that MOUNTS already open (all of ours) would render as the mobile
// drawer for one frame on desktop and then swap to the Radix modal. useSyncExternalStore reads
// matchMedia during render on the client; the server snapshot is "desktop" (the app shell is
// client-rendered, so it only matters for type completeness).
const useMediaQuery = (query: string) =>
  useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );

export default useMediaQuery;
