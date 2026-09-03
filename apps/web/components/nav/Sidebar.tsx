"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";

const NAV_ITEMS = [
  { href: "/home", label: "Home", icon: "🏠" },
  { href: "/chats", label: "Chats", icon: "💬" },
  { href: "/friends", label: "Friends", icon: "👥" },
  { href: "/stories", label: "Stories", icon: "📸" },
  { href: "/explore", label: "Explore", icon: "🌐" },
  { href: "/communities", label: "Communities", icon: "🧭" },
  { href: "/calls", label: "Calls", icon: "📞" },
  { href: "/notifications", label: "Notifications", icon: "🔔" },
  { href: "/saved", label: "Saved", icon: "🔖" },
];

// Icon + label nav rail — deliberately not a collapsed icon-only sidebar,
// so it reads as wayfinding rather than generic SaaS chrome.
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-white/60 px-4 py-6 lg:flex">
      <Link href="/home" className="px-2 font-display text-xl italic">
        Boce
      </Link>

      <nav className="mt-8 flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                active ? "bg-cobalt-soft font-medium text-cobalt-dim" : "text-ink-soft hover:bg-ink/5"
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
        <Link href="/profile" className="flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-ink/5">
          <Avatar name="You" size={32} />
          <span className="text-sm font-medium">Your profile</span>
        </Link>
        <Link href="/settings" className="ml-auto rounded-xl p-2 text-ink-soft hover:bg-ink/5" aria-label="Settings">
          ⚙️
        </Link>
      </div>
    </aside>
  );
}
