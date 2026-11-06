// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayPlan } from "@/lib/client/types";
import { TodaySession } from "./TodaySession";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const plan = (over: Partial<TodayPlan> = {}): TodayPlan => ({
  course: { id: "c1", title: "Python" },
  recommendedBudgetMinutes: 10,
  estimatedDurationMinutes: 8,
  reasons: ["6 questions are due today.", "2 are new."],
  budgetOptions: [5, 10, 20],
  options: [
    { minutes: 5, questionCount: 4, limitedBy: "budget" },
    { minutes: 10, questionCount: 8, limitedBy: null },
    { minutes: 20, questionCount: 8, limitedBy: "content" },
  ],
  availableCount: 12,
  dueCount: 6,
  newCount: 2,
  deferredDueCount: 0,
  limitedBy: null,
  ...over,
});

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let plans: Record<string, TodayPlan | Response>;
let start: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  push.mockClear();
  plans = {
    c1: plan(),
    c2: plan({ course: { id: "c2", title: "Math" }, recommendedBudgetMinutes: 5 }),
  };
  start = () => json({ session: { id: "sess1" } }, 201);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      if (url.startsWith("/api/today?courseId=")) {
        const data = plans[url.split("=")[1]!]!;
        return data instanceof Response ? data : json(data);
      }
      if (url === "/api/sessions") return start(call);
      throw new Error(`unexpected request ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The sentence, whole: the count is in its own element. */
const sentence = (text: string) => (_: string, el: Element | null) =>
  el?.tagName === "P" && el.textContent === text;

const courses = [
  { id: "c1", title: "Python" },
  { id: "c2", title: "Math" },
];

describe("TodaySession", () => {
  it("renders nothing without courses", () => {
    const { container } = render(<TodaySession courses={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("previews the first course with the suggested budget and its reasons", async () => {
    render(<TodaySession courses={courses} />);
    expect(await screen.findByText("6 questions are due today.")).toBeInTheDocument();
    expect(screen.getByLabelText("Course")).toHaveValue("c1");
    expect(screen.getByRole("radio", { name: /10 min/ })).toBeChecked();
    expect(
      screen.getByText(sentence("8 questions fit in 10 minutes, about 8 minutes.")),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Start today’s session/ })).toHaveLength(1);
  });

  it("starts a review with exactly the course, mode and chosen budget, then opens the session", async () => {
    const user = userEvent.setup();
    render(<TodaySession courses={courses} />);
    await screen.findByText("6 questions are due today.");
    await user.click(screen.getByRole("radio", { name: /20 min/ }));
    await user.click(screen.getByRole("button", { name: "Start today’s session" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/sessions/sess1"));
    const post = calls.find((c) => c.url === "/api/sessions")!;
    expect(post.body).toEqual({ courseId: "c1", mode: "review", timeBudgetMinutes: 20 });
  });

  it("does not present the suggested estimate as if it were worked out for another budget", async () => {
    const user = userEvent.setup();
    render(<TodaySession courses={courses} />);
    await screen.findByText("6 questions are due today.");
    await user.click(screen.getByRole("radio", { name: /5 min/ }));
    expect(screen.getByText(sentence("4 questions fit in 5 minutes."))).toBeInTheDocument();
    expect(screen.queryByText(/about \d+ minutes/)).toBeNull();
    expect(screen.queryByText("6 questions are due today.")).toBeNull();
    expect(screen.getByText(/More is due than fits/)).toBeInTheDocument();
  });

  it("previews another course afresh and starts that one", async () => {
    const user = userEvent.setup();
    render(<TodaySession courses={courses} />);
    await screen.findByText("6 questions are due today.");
    await user.selectOptions(screen.getByLabelText("Course"), "c2");
    await waitFor(() => expect(screen.getByRole("radio", { name: /5 min/ })).toBeChecked());
    await user.click(screen.getByRole("button", { name: "Start today’s session" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls.find((c) => c.url === "/api/sessions")!.body).toMatchObject({
      courseId: "c2",
      timeBudgetMinutes: 5,
    });
  });

  it("starts exam practice with the exam mode", async () => {
    const user = userEvent.setup();
    render(<TodaySession courses={courses} />);
    await screen.findByText("6 questions are due today.");
    await user.click(screen.getByRole("button", { name: "Exam practice" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls.find((c) => c.url === "/api/sessions")!.body).toEqual({
      courseId: "c1",
      mode: "exam",
      timeBudgetMinutes: 10,
    });
    expect(screen.getByText(/no help, and your results come at the end/)).toBeInTheDocument();
  });

  it("keeps Learn and Mixed visibly unavailable, with the reason", async () => {
    render(<TodaySession courses={courses} />);
    await screen.findByText("6 questions are due today.");
    const learn = screen.getByRole("button", { name: "Learn a topic" });
    const mixed = screen.getByRole("button", { name: "Mixed practice" });
    expect(learn).toBeDisabled();
    expect(mixed).toBeDisabled();
    expect(learn).toHaveAccessibleDescription(/Not available yet/);
    expect(mixed).toHaveAccessibleDescription(/Not available yet/);
  });

  it("offers to resume a running session instead of starting another, with its fixed length", async () => {
    plans.c1 = plan({ liveSessionId: "live9" });
    render(<TodaySession courses={courses} />);
    const link = await screen.findByRole("link", { name: "Resume today’s session" });
    expect(link).toHaveAttribute("href", "/sessions/live9");
    expect(screen.getByText(/length was fixed when it started/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start today’s session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Exam practice" })).toBeDisabled();
  });

  it("explains an empty course instead of offering to start", async () => {
    plans.c1 = plan({ availableCount: 0, options: [] });
    render(<TodaySession courses={[courses[0]!]} />);
    expect(await screen.findByText(/Nothing is ready to practise/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the course" })).toHaveAttribute(
      "href",
      "/courses/c1",
    );
    expect(screen.queryByRole("button", { name: "Start today’s session" })).toBeNull();
  });

  it("shows a loading line, then an error with a retry that works", async () => {
    let n = 0;
    plans.c1 = new Response();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchMock.getMockImplementation() as (
      u: string,
      i?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/today") && n++ === 0) {
        return json({ error: { code: "error", message: "Something went wrong." } }, 500);
      }
      plans.c1 = plan();
      return base(url, init);
    });
    const user = userEvent.setup();
    render(<TodaySession courses={[courses[0]!]} />);
    expect(screen.getByText(/Working out today’s session/)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("6 questions are due today.")).toBeInTheDocument();
  });

  it("explains when the course has nothing playable and keeps the button usable", async () => {
    start = () => json({ error: { code: "no_playable_questions", message: "No questions" } }, 409);
    const user = userEvent.setup();
    render(<TodaySession courses={[courses[0]!]} />);
    await screen.findByText("6 questions are due today.");
    await user.click(screen.getByRole("button", { name: "Start today’s session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no questions to practise/i);
    expect(screen.getByRole("button", { name: "Start today’s session" })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  it("starts only once while the request is pending", async () => {
    let release!: (r: Response) => void;
    start = () => {
      throw new Error("not used");
    };
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchMock.getMockImplementation() as (
      u: string,
      i?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === "/api/sessions" ? new Promise<Response>((r) => (release = r)) : base(url, init),
    );
    const user = userEvent.setup();
    render(<TodaySession courses={[courses[0]!]} />);
    await screen.findByText("6 questions are due today.");
    await user.click(screen.getByRole("button", { name: "Start today’s session" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exam practice" })).toBeDisabled();
    release(json({ session: { id: "sess2" } }, 201));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });
});
