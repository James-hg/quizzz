// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SampleCourses, type SampleSummary } from "./SampleCourses";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.unstubAllGlobals();
});

const python: SampleSummary = {
  language: "python",
  title: "Python basics",
  subject: "Intro programming",
  questionCount: 30,
  checkedQuestionCount: 0,
};
const java: SampleSummary = { ...python, language: "java", title: "Java basics" };

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SampleCourses", () => {
  it("renders nothing when there are no samples", () => {
    const { container } = render(<SampleCourses samples={[]} loaded={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each sample and says the content is an unchecked draft", () => {
    render(<SampleCourses samples={[python, java]} loaded={{}} />);
    expect(screen.getByRole("heading", { name: "Explore a sample course" })).toBeInTheDocument();
    expect(screen.getByText("Python basics")).toBeInTheDocument();
    expect(screen.getByText("Java basics")).toBeInTheDocument();
    expect(screen.getAllByText("Draft, not checked")).toHaveLength(2);
    expect(screen.getByText(/has not been checked/i)).toBeInTheDocument();
    expect(screen.getAllByText("30 questions")).toHaveLength(2);
  });

  it("does not claim a draft when every question is checked", () => {
    render(<SampleCourses samples={[{ ...python, checkedQuestionCount: 30 }]} loaded={{}} />);
    expect(screen.queryByText(/not checked/i)).not.toBeInTheDocument();
  });

  it("shows a partial count when only some questions are checked", () => {
    render(<SampleCourses samples={[{ ...python, checkedQuestionCount: 10 }]} loaded={{}} />);
    expect(screen.getByText("20 not checked")).toBeInTheDocument();
  });

  it("adds the sample and goes to the new course", async () => {
    const fetchMock = stubFetch(201, { courseId: "course-1", alreadyLoaded: false });
    const user = userEvent.setup();
    render(<SampleCourses samples={[python]} loaded={{}} />);
    await user.click(screen.getByRole("button", { name: "Add Python basics to my courses" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/samples/python/load",
      expect.objectContaining({ method: "POST" }),
    );
    expect(push).toHaveBeenCalledWith("/courses/course-1");
  });

  it("offers the existing copy instead of loading a second one", () => {
    render(<SampleCourses samples={[python, java]} loaded={{ python: { courseId: "mine" } }} />);
    expect(screen.getByRole("link", { name: "Open your copy" })).toHaveAttribute(
      "href",
      "/courses/mine",
    );
    expect(screen.queryByRole("button", { name: /Add Python basics/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Java basics/ })).toBeInTheDocument();
  });

  it("shows the server's message and stays on the page when loading fails", async () => {
    stubFetch(404, { error: { code: "not_found", message: "Sample course not found" } });
    const user = userEvent.setup();
    render(<SampleCourses samples={[python]} loaded={{}} />);
    await user.click(screen.getByRole("button", { name: /Add Python basics/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sample course not found");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Add Python basics/ })).toBeEnabled();
  });
});
