import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { renderWithProviders, makeQueryClient } from "@/test/render";

function GreetingList() {
  const { data, isPending, isError } = useQuery<string[]>({
    queryKey: ["greetings"],
    queryFn: async () => ["Hello, world!", "Welcome back!"],
  });

  if (isPending) return <p>Loading…</p>;
  if (isError) return <p role="alert">Something went wrong</p>;

  return (
    <ul>
      {data?.map((msg) => (
        <li key={msg}>{msg}</li>
      ))}
    </ul>
  );
}

describe("renderWithProviders", () => {
  it("wraps children in a QueryClientProvider", async () => {
    renderWithProviders(<GreetingList />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Hello, world!")).toBeInTheDocument();
      expect(screen.getByText("Welcome back!")).toBeInTheDocument();
    });
  });

  it("accepts a pre-seeded queryClient to skip loading state", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(["greetings"], ["Seeded greeting"]);

    renderWithProviders(<GreetingList />, { queryClient });

    expect(screen.getByText("Seeded greeting")).toBeInTheDocument();
  });

  it("returns a userEvent instance for firing interactions", async () => {
    const onClick = vi.fn();

    const { user } = renderWithProviders(
      <button type="button" onClick={onClick}>
        Click me
      </button>,
    );

    await user.click(screen.getByRole("button", { name: "Click me" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("exposes the queryClient for data inspection in tests", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(["greetings"], ["Test entry"]);

    const { queryClient: returnedClient } = renderWithProviders(
      <GreetingList />,
      { queryClient },
    );

    expect(returnedClient.getQueryData(["greetings"])).toEqual(["Test entry"]);
  });
});
