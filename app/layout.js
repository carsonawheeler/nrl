export const metadata = {
  title: 'National Rocket League',
  description: 'NRL league stats, standings, and history',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#05080d', color: '#e7eef6',
        fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
