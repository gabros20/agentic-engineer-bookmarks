"use client";

import { useLanguage, type Lang } from "@/lib/i18n";

const OPTIONS: { code: Lang; flag: string; label: string }[] = [
  { code: "en", flag: "gb", label: "English" },
  { code: "hu", flag: "hu", label: "Magyar" },
];

export function LanguageSwitcher() {
  const { lang, setLang, t } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t("lang.label")}
      className="flex items-center gap-0.5 rounded-full border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-0.5 text-[color:var(--color-ink)]"
    >
      {OPTIONS.map((opt) => {
        const active = lang === opt.code;
        return (
          <button
            key={opt.code}
            type="button"
            onClick={() => setLang(opt.code)}
            aria-pressed={active}
            aria-label={opt.label}
            title={opt.label}
            className={`grid h-8 w-9 place-items-center rounded-full transition ${
              active
                ? "bg-[color:var(--color-surface-cream-strong)]"
                : "hover:bg-[color:var(--color-surface-card)]"
            }`}
          >
            <span className={`fi fi-${opt.flag}`} style={{ width: "20px", height: "14px", borderRadius: "2px" }} />
          </button>
        );
      })}
    </div>
  );
}
