import { PageHeader, EmptyState } from "@/components/ui/PageHeader";

export default function FriendsPage() {
  return (
    <div>
      <PageHeader title="Friends" description="Requests, your friends list, and people you may know." />
      <EmptyState
        icon="🧑‍🤝‍🧑"
        title="No friends yet"
        description="Search by name, username, or school — or share your profile link or QR code."
      />
    </div>
  );
}
