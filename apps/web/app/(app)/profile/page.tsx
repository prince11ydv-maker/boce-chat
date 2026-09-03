import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Avatar";

export default function ProfilePage() {
  return (
    <div>
      <PageHeader title="Profile" />
      <div className="px-6 py-8 lg:px-10">
        <div className="flex items-center gap-4">
          <Avatar name="You" size={72} />
          <div>
            <p className="text-lg font-medium">Your name</p>
            <p className="text-sm text-ink-soft">@username · Add a bio to tell people about yourself</p>
          </div>
        </div>
        <p className="mt-6 max-w-md text-sm text-ink-soft">
          Full name, date of birth, and school are locked. To change them, submit a profile change
          request from Settings for an admin to review.
        </p>
      </div>
    </div>
  );
}
