import type { AnchorHTMLAttributes } from 'react';
import { Logo, type LogoProps } from './Logo';

export interface LogoLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  logo?: LogoProps;
}

/** The app-header brand link: lockup at header size, named "ShrooMap home"; the image itself is decorative. */
export function LogoLink({ href = '/', logo, className, ...rest }: LogoLinkProps) {
  return (
    <a
      href={href}
      aria-label="ShrooMap home"
      className={['inline-flex min-h-11 min-w-11 items-center', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Logo size="header" {...(logo as object)} alt="" />
    </a>
  );
}
