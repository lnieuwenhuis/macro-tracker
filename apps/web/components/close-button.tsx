type CloseButtonProps = {
  label?: string;
  disabled?: boolean;
  className?: string;
  iconSize?: number;
  onClick: () => void;
};

export function CloseButton({
  label = "Close",
  disabled,
  // 44px: WCAG 2.5.8 minimum for a phone-first app.
  className = "flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-ink)]",
  iconSize = 16,
  onClick,
}: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      aria-label={label}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <line x1="3" y1="3" x2="13" y2="13" />
        <line x1="13" y1="3" x2="3" y2="13" />
      </svg>
    </button>
  );
}
