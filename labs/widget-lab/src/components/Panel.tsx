import type { ReactNode } from 'react';

export function Panel({ title, description, action, children, className = '', id }: {
  title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string; id: string;
}) {
  return <section className={`panel ${className}`} aria-labelledby={`${id}-title`}>
    <header className="panel-heading"><div><h2 id={`${id}-title`}>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>
    {children}
  </section>;
}
