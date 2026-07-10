export interface NavItem {
  label: string;
  href: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Posts", href: "/posts" },
  { label: "Upload", href: "/upload" },
  { label: "Admin", href: "/admin" },
];
