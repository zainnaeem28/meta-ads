import type { ReactNode } from 'react';
import { Icon } from '../../icons';

export interface BreadcrumbItem {
  label: string;
  /** Omit on the current page (the last item). */
  href?: string;
}

export interface PageHeaderProps {
  /** The page's one `h1`. */
  title: string;
  /** One line under the title. */
  description?: string;
  /** Primary action(s) at the right; full width on phones. */
  actions?: ReactNode;
  /** Campaign pages only: Campaigns › campaign name. */
  breadcrumb?: BreadcrumbItem[];
  /** Campaign stage tabs (CMP-014), rendered below the title row. */
  tabs?: ReactNode;
  className?: string;
}

/** CMP-033: the page's `h1`, optional description, actions, and (inside a campaign) breadcrumb and stage tabs. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  tabs,
  className,
}: PageHeaderProps) {
  const classes = ['page-header flex flex-col gap-3', className].filter(Boolean).join(' ');
  return (
    <header className={classes} data-variant={breadcrumb || tabs ? 'campaign' : 'default'}>
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-ui text-muted-foreground">
            {breadcrumb.map((item, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <li key={`${i}-${item.label}`} className="flex items-center gap-1">
                  {item.href && !last ? (
                    <a
                      href={item.href}
                      className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {item.label}
                    </a>
                  ) : (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className={last ? 'font-medium text-foreground' : undefined}
                    >
                      {item.label}
                    </span>
                  )}
                  {last ? null : (
                    <span aria-hidden="true">
                      <Icon name="chevron-right" size={16} />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page font-semibold text-foreground">{title}</h1>
          {description ? <p className="text-ui text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-col gap-2 md:flex-row md:items-center [&>*]:max-md:w-full">
            {actions}
          </div>
        ) : null}
      </div>
      {tabs}
    </header>
  );
}
