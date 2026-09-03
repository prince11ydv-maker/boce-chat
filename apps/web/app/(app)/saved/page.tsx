import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function SavedPage() {
  return (
    <div>
      <PageHeader title="Saved" description="Posts, messages, files, and links you've bookmarked." />
      <EmptyState icon="🔖" title="Nothing saved yet" description="Save a message or post and it'll show up here." />
    </div>
  );
}
