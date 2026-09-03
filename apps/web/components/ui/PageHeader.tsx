export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="border-b border-line px-6 py-5 lg:px-10">
      <h1 className="text-xl font-medium">{title}</h1>
      {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
    </header>
  );
}

export function EmptyState({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <span className="text-3xl" aria-hidden>{icon}</span>
      <p className="mt-4 font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-ink-soft">{description}</p>
    </div>
  );
}
