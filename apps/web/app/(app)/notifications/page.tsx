import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader title="Notifications" />
      <EmptyState icon="🔔" title="You're all caught up" description="Messages, requests, and mentions will show up here." />
    </div>
  );
}
