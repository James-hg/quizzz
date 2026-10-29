// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "./SettingsForms";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

const profile = { email: "local@quizzz.local", displayName: "", timezone: "UTC" };

describe("ProfileForm", () => {
  it("lets a signed-in user edit their email", () => {
    render(<ProfileForm profile={profile} timezones={["UTC"]} />);
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("readonly");
  });

  it("keeps the email read-only, with a reason, while login is off", () => {
    render(<ProfileForm profile={profile} timezones={["UTC"]} emailLocked />);
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("readonly");
    expect(email).toHaveAccessibleDescription(/login is turned off/i);
  });
});
