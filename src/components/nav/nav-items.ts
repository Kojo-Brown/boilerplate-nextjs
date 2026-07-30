import type { Route } from "next";

export interface NavItem {
  label: string;
  // Typed routes are enabled, so `href` is checked against the routes Next
  // generates from `app/`. A link to a page that does not exist is a type error
  // rather than a 404 found at runtime.
  href: Route;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Posts", href: "/posts" },
  { label: "Upload", href: "/upload" },
  { label: "Images", href: "/images" },
  { label: "Admin", href: "/admin" },
];
