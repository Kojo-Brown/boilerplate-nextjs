// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";

describe("Card", () => {
  it("renders a div", () => {
    const { container } = render(<Card />);
    expect(container.firstChild?.nodeName).toBe("DIV");
  });

  it("applies custom className", () => {
    const { container } = render(<Card className="custom" />);
    expect(container.firstChild).toHaveClass("custom");
  });

  it("renders children", () => {
    render(<Card>Content</Card>);
    expect(screen.getByText("Content")).toBeInTheDocument();
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>Header</CardHeader>);
    expect(screen.getByText("Header")).toBeInTheDocument();
  });
});

describe("CardTitle", () => {
  it("renders an h3 element", () => {
    render(<CardTitle>My Title</CardTitle>);
    expect(
      screen.getByRole("heading", { level: 3, name: "My Title" }),
    ).toBeInTheDocument();
  });
});

describe("CardDescription", () => {
  it("renders a paragraph", () => {
    const { container } = render(<CardDescription>Desc</CardDescription>);
    expect(container.firstChild?.nodeName).toBe("P");
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>Body</CardContent>);
    expect(screen.getByText("Body")).toBeInTheDocument();
  });
});

describe("CardFooter", () => {
  it("renders children", () => {
    render(<CardFooter>Footer</CardFooter>);
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });
});

describe("Card composition", () => {
  it("renders a full card composition", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Title");
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });
});
