"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Touch-optimized bottom nav — the 5 highest-frequency destinations only;
// everything else (stories, saved, notifications) lives one tap away
// from Home, per spec §40's "optimized for touch" guidance.
const MOBILE_ITEMS = [
  { href: "/home", label: "Home", icon: "🏠" },
  { href: "/chats", label: "Chats", icon: "💬" },
  { href: "/friends", label: "Friends", icon: "👥" },
  { href: "/explore", label: "Explore", icon: "🌐" },
  { href: "/profile", label: "Profile", icon: "👤" },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white/95 backdrop-blur lg:hidden">
      {MOBILE_ITEMS.map((item) => {
        const active = pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
              active ? "text-cobalt-dim" : "text-ink-soft"
            }`}
          >
            <span className="text-lg" aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
