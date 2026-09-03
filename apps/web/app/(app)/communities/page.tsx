import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function CommunitiesPage() {
  return (
    <div>
      <PageHeader title="Communities" description="Servers for your school, clubs, and interests — channels, roles, and events." />
      <EmptyState icon="🧭" title="You haven't joined any communities" description="Create one, or ask a friend for an invite link." />
    </div>
  );
}
