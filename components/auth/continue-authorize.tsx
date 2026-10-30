"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { OtherDeviceNotice, isHandheld, isLoopbackRedirect } from "@/components/auth/other-device-notice";

const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

/** Inverse of login-form.tsx's encodeTarget (base64url of a same-origin path). */
function decodeTarget(value: string): string {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return "";
  }
}

/**
 * After the magic link signs this device in: resume the app's OAuth authorize request — unless
 * this is a phone and the app waits on a computer's localhost (the authorize endpoint would go
 * straight there when the app was approved before, skipping /consent). Only forwards to the
 * authorize endpoint on this origin, so it can't be used as an open redirect.
 */
export function ContinueAuthorize() {
  const [blocked, setBlocked] = useState<{ to: string } | null>(null);

  useEffect(() => {
    const raw = decodeTarget(new URLSearchParams(window.location.search).get("to") ?? "");
    let target: URL | null = null;
    try {
      target = new URL(raw, window.location.origin);
    } catch {
      target = null;
    }
    if (!target || target.origin !== window.location.origin || target.pathname !== AUTHORIZE_PATH) {
      window.location.replace("/");
      return;
    }
    const to = `${target.pathname}${target.search}`;
    if (isLoopbackRedirect(target.searchParams.get("redirect_uri")) && isHandheld()) setBlocked({ to });
    else window.location.replace(to);
  }, []);

  if (blocked) return <OtherDeviceNotice onOverride={() => window.location.replace(blocked.to)} />;
  return (
    <main className="grid min-h-[100svh] place-items-center bg-[color:var(--color-canvas)]">
      <Loader2 size={20} className="animate-spin text-[color:var(--color-muted)]" />
    </main>
  );
}
