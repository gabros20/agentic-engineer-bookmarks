import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Cross-origin requests carry no Referer. video.twimg.com 403s any foreign Referer, so
          // inline video playback (components/bookmark-card.tsx) needs this — <video> has no per-
          // element referrerpolicy. It also stops X's CDNs learning this private app's URL from
          // every avatar/photo/poster. Same-origin requests are unchanged ("no-referrer" would
          // turn a same-origin POST's Origin into "null" and trip Better Auth's origin check).
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
