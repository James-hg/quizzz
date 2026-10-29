import type { Metadata } from "next";
import { PasswordForm, ProfileForm } from "@/components/SettingsForms";
import { isAuthDisabled } from "@/server/auth/local-user";
import { requirePageUser } from "@/server/auth/page";

export const metadata: Metadata = { title: "Settings · Quizzz" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageUser();
  // Listed on the server so the options are identical during hydration.
  const timezones = Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]));
  if (!timezones.includes(user.timezone)) timezones.unshift(user.timezone);

  return (
    <div className="stack page-narrow">
      <h1>Settings</h1>
      <ProfileForm
        profile={{
          email: user.email,
          displayName: user.displayName ?? "",
          timezone: user.timezone,
        }}
        timezones={timezones}
        emailLocked={isAuthDisabled()}
      />
      <PasswordForm />
    </div>
  );
}
