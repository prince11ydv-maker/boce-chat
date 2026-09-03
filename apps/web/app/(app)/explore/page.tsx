import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function ExplorePage() {
  return (
    <div>
      <PageHeader title="Explore" description="Public posts, communities, and people you may know." />
      <EmptyState icon="🌐" title="Nothing to explore yet" description="Public communities and trending posts will show up here." />
    </div>
  );
}
