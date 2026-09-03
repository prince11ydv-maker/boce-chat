export function Avatar({
  name,
  src,
  size = 40,
  online,
}: {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full bg-cobalt-soft text-cobalt-dim font-medium"
          style={{ fontSize: size * 0.38 }}
        >
          {initials}
        </span>
      )}
      {online !== undefined && (
        <span
          className={`absolute bottom-0 right-0 rounded-full border-2 border-paper ${
            online ? "bg-mint" : "bg-ink-soft/40"
          }`}
          style={{ width: size * 0.28, height: size * 0.28 }}
          aria-label={online ? "Online" : "Offline"}
        />
      )}
    </span>
  );
}
