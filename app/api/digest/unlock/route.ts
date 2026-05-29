import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const COOKIE_NAME = "digest_unlock";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

export async function POST(request: NextRequest) {
  const expected = process.env.DIGEST_UNLOCK_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "Server misconfigured" }, { status: 500 });
  }

  let provided = "";
  try {
    const body = (await request.json()) as { key?: unknown };
    if (typeof body?.key === "string") provided = body.key;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  if (!provided || provided !== expected) {
    return NextResponse.json({ ok: false, error: "Invalid passkey" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });

  const cookieOpts = {
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_S,
  };

  response.cookies.set(COOKIE_NAME, expected, { ...cookieOpts, httpOnly: true });
  response.cookies.set("digest_ok", "1", { ...cookieOpts, httpOnly: false });

  return response;
}

// Friendly redirect for anyone hitting the legacy ?key= URL.
export function GET() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Unlock is now an in-app passkey prompt. Click the AI Digest button in the app and enter the passkey.",
    },
    { status: 410 },
  );
}
