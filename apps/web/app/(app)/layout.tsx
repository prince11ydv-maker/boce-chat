import { Sidebar } from "@/components/nav/Sidebar";
import { MobileNav } from "@/components/nav/MobileNav";

// Shell for every authenticated route: sidebar on desktop, bottom nav on
// mobile, per spec §40/§53. Route-level auth checking happens in
// middleware.ts (redirects to / if there's no valid session cookie).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 pb-16 lg:pb-0">{children}</main>
      <MobileNav />
    </div>
  );
}
