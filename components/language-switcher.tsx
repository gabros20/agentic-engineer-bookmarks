"use client";

import { motion } from "motion/react";
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
      className="relative flex items-center gap-0.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-0.5 text-[color:var(--color-ink)]"
    >
      {OPTIONS.map((opt) => {
        const active = lang === opt.code;
        return (
          <motion.button
            key={opt.code}
            type="button"
            onClick={() => setLang(opt.code)}
            aria-pressed={active}
            aria-label={opt.label}
            title={opt.label}
            whileTap={{ scale: 0.94 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className="relative grid h-8 w-9 place-items-center rounded-sm"
          >
            {active ? (
              <motion.span
                layoutId="lang-active"
                className="absolute inset-0 rounded-sm bg-[color:var(--color-surface-cream-strong)]"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            ) : null}
            <span
              className={`fi fi-${opt.flag} relative`}
              style={{ width: "20px", height: "14px", borderRadius: "2px" }}
            />
          </motion.button>
        );
      })}
    </div>
  );
}
