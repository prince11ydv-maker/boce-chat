import { PageHeader } from "@/components/ui/PageHeader";

const GROUPS = [
  { title: "Account", items: ["Password & security", "Two-factor authentication", "Active devices"] },
  { title: "Privacy", items: ["Profile visibility", "Online status & last seen", "Blocked users"] },
  { title: "Chats", items: ["Disappearing messages", "Chat backup", "Storage & data"] },
  { title: "Notifications", items: ["Message notifications", "Push notifications"] },
];

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="divide-y divide-line px-6 lg:px-10">
        {GROUPS.map((group) => (
          <section key={group.title} className="py-6">
            <h2 className="text-sm font-medium text-ink-soft">{group.title}</h2>
            <ul className="mt-3 space-y-1">
              {group.items.map((item) => (
                <li key={item} className="rounded-lg px-3 py-2.5 text-sm hover:bg-ink/5">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
