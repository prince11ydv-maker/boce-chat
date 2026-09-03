import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function StoriesPage() {
  return (
    <div>
      <PageHeader title="Stories" description="Photos, videos, and text stories that disappear after 24 hours." />
      <EmptyState icon="📸" title="No stories yet" description="Share a photo, video, or text update with your friends." />
    </div>
  );
}
