/**
 * The three presentation components the editor used from
 * `@schnsrw/design-system`, reimplemented here.
 *
 * That package lived in a git submodule this repository cannot fetch, so the
 * import made a clean clone unbuildable. Only these three were used, and only
 * for presentation -- no state, no context, no theming machinery -- so
 * replacing them is a smaller and more honest change than carrying a
 * dependency nobody outside the original organisation can install.
 *
 * Behaviour is preserved deliberately, not just appearance: Button remains a
 * real <button> so it keeps keyboard activation, focus order and the disabled
 * state for free, and Badge carries its meaning in text rather than in colour
 * alone.
 *
 * Styling is entirely CSS custom properties from editor-tokens.css, so these
 * follow the host application's theme without knowing anything about it.
 */
import React from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<BadgeTone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--color-text-secondary)', bg: 'var(--color-hover)' },
  success: { fg: 'var(--color-success)', bg: 'var(--color-success-soft)' },
  warning: { fg: 'var(--color-warning)', bg: 'var(--color-warning-soft)' },
  danger: { fg: 'var(--color-danger)', bg: 'var(--color-danger-soft)' },
  info: { fg: 'var(--color-info)', bg: 'var(--color-info-soft)' },
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** Show a small status dot before the label. */
  dot?: boolean;
  children?: React.ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, children }: BadgeProps) {
  const { fg, bg } = TONE[tone] ?? TONE.neutral;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '2px var(--space-2)',
        borderRadius: 999,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        lineHeight: 1.6,
        color: fg,
        background: bg,
        whiteSpace: 'nowrap',
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            flex: '0 0 auto',
          }}
        />
      )}
      {children}
    </span>
  );
}

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  /** Material Symbols ligature name, rendered before the label. */
  icon?: string;
  children?: React.ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  style,
  disabled,
  ...rest
}: ButtonProps) {
  const small = size === 'sm';

  const palette =
    variant === 'primary'
      ? { fg: '#fff', bg: 'var(--color-accent)', border: 'transparent' }
      : variant === 'ghost'
        ? { fg: 'var(--color-text)', bg: 'transparent', border: 'transparent' }
        : {
            fg: 'var(--color-text)',
            bg: 'var(--color-surface-raised)',
            border: 'var(--color-border-strong)',
          };

  return (
    // A real <button>: keyboard activation, focus order, disabled semantics and
    // the implicit ARIA role all come with the element. A styled <div> would
    // mean reimplementing every one of them, usually incompletely.
    <button
      type="button"
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: small ? '4px var(--space-2)' : '6px var(--space-4)',
        border: '1px solid ' + palette.border,
        borderRadius: 'var(--radius-lg)',
        background: palette.bg,
        color: palette.fg,
        fontFamily: 'var(--font-sans)',
        fontSize: small ? 'var(--text-xs)' : '0.875rem',
        fontWeight: 500,
        lineHeight: 1.4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background var(--motion-fast) var(--ease-out)',
        ...style,
      }}
      {...rest}
    >
      {icon && (
        <span
          className="material-symbols-outlined"
          aria-hidden="true"
          style={{ fontSize: small ? 16 : 18, lineHeight: 1 }}
        >
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

export interface AvatarPerson {
  name: string;
  color?: string;
  active?: boolean;
}

export interface AvatarStackProps {
  people: AvatarPerson[];
  /** Diameter in pixels. */
  size?: number;
  /** Show at most this many, then a "+n" chip. */
  max?: number;
}

/** The first letter of the first word, which is what a presence chip shows. */
function initial(name: string): string {
  const trimmed = name.trim();

  return trimmed === '' ? '?' : trimmed[0]!.toUpperCase();
}

export function AvatarStack({ people, size = 26, max = 4 }: AvatarStackProps) {
  const shown = people.slice(0, Math.max(0, max));
  const overflow = people.length - shown.length;

  return (
    // One label for the whole group. Announcing five separate initials tells a
    // screen-reader user nothing; "3 people editing" tells them what they need.
    <span
      style={{ display: 'inline-flex', alignItems: 'center' }}
      role="group"
      aria-label={
        people.length === 1
          ? people[0]!.name + ' is editing'
          : people.length + ' people editing'
      }
    >
      {shown.map((person, index) => (
        <span
          key={person.name + '-' + index}
          title={person.name}
          aria-hidden="true"
          style={{
            width: size,
            height: size,
            marginLeft: index === 0 ? 0 : -(size / 3.5),
            borderRadius: '50%',
            background: person.color ?? 'var(--color-accent)',
            color: '#fff',
            border: '2px solid var(--color-surface)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-sans)',
            fontSize: Math.round(size * 0.42),
            fontWeight: 600,
            // Someone who has gone idle is still present, just quieter.
            opacity: person.active === false ? 0.45 : 1,
            boxSizing: 'border-box',
          }}
        >
          {initial(person.name)}
        </span>
      ))}

      {overflow > 0 && (
        <span
          aria-hidden="true"
          style={{
            marginLeft: -(size / 3.5),
            height: size,
            padding: '0 ' + Math.round(size * 0.28) + 'px',
            borderRadius: 999,
            background: 'var(--color-surface-strip)',
            color: 'var(--color-text-secondary)',
            border: '2px solid var(--color-surface)',
            display: 'inline-flex',
            alignItems: 'center',
            fontFamily: 'var(--font-sans)',
            fontSize: Math.round(size * 0.4),
            fontWeight: 600,
            boxSizing: 'border-box',
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
