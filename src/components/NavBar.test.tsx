// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavBar } from "./NavBar";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

describe("NavBar", () => {
  it("offers sign out when login is on", () => {
    render(<NavBar name="Ada" />);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText("Login off")).not.toBeInTheDocument();
  });

  it("shows that login is off instead of a sign-out button", () => {
    render(<NavBar name="Local user" loginDisabled />);
    expect(screen.getByText("Login off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });
});
