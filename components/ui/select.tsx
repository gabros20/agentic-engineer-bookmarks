"use client";

import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export type SelectOption<T extends string = string> = {
  value: T;
  label: ReactNode;
};

type Props<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel?: string;
  leadingIcon?: ReactNode;
  className?: string;
  align?: "start" | "end";
};

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  leadingIcon,
  className,
  align = "start",
}: Props<T>) {
  return (
    <BaseSelect.Root value={value} onValueChange={(v) => onValueChange(v as T)}>
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={[
          "group relative flex min-h-10 w-full items-center gap-2 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] pl-3 pr-2 text-sm font-medium text-[color:var(--color-ink)] outline-none transition hover:bg-[color:var(--color-surface-card)] focus-visible:border-[color:var(--color-primary)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/15 data-[popup-open]:border-[color:var(--color-primary)]",
          className ?? "",
        ].join(" ")}
      >
        {leadingIcon ? (
          <span className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-muted)]">
            {leadingIcon}
          </span>
        ) : null}
        <BaseSelect.Value className="min-w-0 flex-1 truncate text-left" />
        <BaseSelect.Icon className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-muted)] transition-transform group-data-[popup-open]:rotate-180">
          <ChevronDown size={14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} align={align} className="z-50 outline-none">
          <BaseSelect.Popup
            className="origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] py-1 text-sm shadow-[0_8px_24px_rgba(20,20,19,0.10)] transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
          >
            {options.map((opt) => (
              <BaseSelect.Item
                key={opt.value}
                value={opt.value}
                className="flex min-h-9 cursor-default select-none items-center gap-2 px-2.5 text-[color:var(--color-ink)] outline-none transition-colors data-[highlighted]:bg-[color:var(--color-surface-card)] data-[selected]:text-[color:var(--color-primary)]"
              >
                <BaseSelect.ItemIndicator className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-primary)]">
                  <Check size={14} />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText className="data-[selected]:font-semibold">
                  {opt.label}
                </BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
