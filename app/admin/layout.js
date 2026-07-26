// Gives the /admin route its own home-screen icon + title, distinct from the
// public site (a separate crest with an ADMIN badge), so a saved shortcut to
// the admin screen is easy to tell apart.
export const metadata = {
  title: 'NRL Admin',
  appleWebApp: { capable: true, title: 'NRL Admin', statusBarStyle: 'black-translucent' },
  icons: {
    icon: '/logos/nrl.webp',
    apple: '/apple-touch-icon-admin.png',
  },
};

export default function AdminLayout({ children }) {
  return children;
}
