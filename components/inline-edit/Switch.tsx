'use client'
import clsx from 'clsx'

// Animated copper-tinted toggle switch. Replaces the checkbox primitive
// in every admin form for boolean fields and publish toggles.
//
// Accessible: native button with role="switch" and aria-checked, focus
// ring uses the copper-300 token. Touch target is the full 44px
// vertical hit area (track + label area).
export function Switch({
  checked,
  onChange,
  label,
  help,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  help?: string
  disabled?: boolean
  id?: string
}) {
  // Wrapper is intentionally a <span>, not a <label htmlFor={id}>. A
  // `<label>` that contains a focusable element re-fires the click on
  // the contained control after the user clicks anywhere in the label,
  // and the inner button's onClick runs TWICE — once from the direct
  // click, once from the label re-dispatch — so the toggle reverts in
  // the same gesture. The label-for-button pattern only "looks right"
  // until you click it. The visual label/help text is still clickable
  // because the click bubbles to the inner button via the parent
  // onClick on the wrapper.
  const toggle = () => !disabled && onChange(!checked)
  return (
    <span
      className={clsx(
        'inline-flex items-start gap-3 select-none',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      )}
      onClick={(e) => {
        // If the click already landed on the inner button, the button's
        // own onClick fires — don't double-toggle.
        if ((e.target as HTMLElement).closest('[role="switch"]')) return
        toggle()
      }}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={toggle}
        className={clsx(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-all duration-standard ease-standard cavecms-focus-ring shadow-inner',
          checked
            ? 'bg-copper-500 border-copper-600'
            : 'bg-cream-100 border-warm-stone/30',
        )}
      >
        <span
          className={clsx(
            'inline-block h-5 w-5 rounded-full bg-cream-50 shadow-[0_2px_6px_rgba(5,5,5,0.25)] transition-transform duration-standard ease-standard',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      {(label || help) && (
        <span className="flex flex-col gap-0.5 pt-0.5">
          {label && (
            <span className="text-sm font-medium text-near-black">{label}</span>
          )}
          {help && (
            <span className="text-[11px] text-warm-stone leading-snug">{help}</span>
          )}
        </span>
      )}
    </span>
  )
}
