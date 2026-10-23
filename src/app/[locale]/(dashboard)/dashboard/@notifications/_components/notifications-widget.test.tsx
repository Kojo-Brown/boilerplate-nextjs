// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotificationsWidget } from "./notifications-widget";
import type { Notification } from "./notifications-widget";

const mockNotifications: Notification[] = [
  {
    id: "1",
    title: "Welcome aboard",
    body: "Your account is ready.",
    variant: "success",
    timestamp: "Just now",
  },
  {
    id: "2",
    title: "Draft saved",
    body: "Your post draft was saved automatically.",
    variant: "info",
    timestamp: "2 minutes ago",
  },
  {
    id: "3",
    title: "Publish reminder",
    body: "You have 2 unpublished drafts.",
    variant: "warning",
    timestamp: "1 hour ago",
  },
];

describe("NotificationsWidget", () => {
  it("renders the section heading", () => {
    render(<NotificationsWidget notifications={mockNotifications} />);
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("renders all notification titles", () => {
    render(<NotificationsWidget notifications={mockNotifications} />);
    expect(screen.getByText("Welcome aboard")).toBeInTheDocument();
    expect(screen.getByText("Draft saved")).toBeInTheDocument();
    expect(screen.getByText("Publish reminder")).toBeInTheDocument();
  });

  it("renders notification bodies", () => {
    render(<NotificationsWidget notifications={mockNotifications} />);
    expect(screen.getByText("Your account is ready.")).toBeInTheDocument();
  });

  it("renders timestamps", () => {
    render(<NotificationsWidget notifications={mockNotifications} />);
    expect(screen.getByText("Just now")).toBeInTheDocument();
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();
  });

  it("shows empty state when no notifications", () => {
    render(<NotificationsWidget notifications={[]} />);
    expect(screen.getByText("No new notifications.")).toBeInTheDocument();
  });

  it("renders a list item for each notification", () => {
    render(<NotificationsWidget notifications={mockNotifications} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
  });
});
