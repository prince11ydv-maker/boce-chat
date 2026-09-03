import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function HomePage() {
  return (
    <div>
      <PageHeader title="Home" description="Your feed, recent chats, and what your circle's up to." />
      <EmptyState
        icon="👋"
        title="Your feed is quiet for now"
        description="Add friends and join a community to start seeing posts and stories here."
      />
    </div>
  );
}
