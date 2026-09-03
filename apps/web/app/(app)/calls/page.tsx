import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function CallsPage() {
  return (
    <div>
      <PageHeader title="Calls" description="Your voice and video call history." />
      <EmptyState icon="📞" title="No calls yet" description="Start a voice or video call from any chat." />
    </div>
  );
}
