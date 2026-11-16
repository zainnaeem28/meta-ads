import type { Metadata } from 'next';
import { SettingsScreen } from '../../../../features/fe-screen-013/SettingsScreen';

export const metadata: Metadata = { title: 'Settings', robots: { index: false, follow: false } };

/** SCREEN-013: sign-up mode and the read-only security configuration (administrators; the api authorises). */
export default function AdminSettingsPage() {
  return <SettingsScreen />;
}
