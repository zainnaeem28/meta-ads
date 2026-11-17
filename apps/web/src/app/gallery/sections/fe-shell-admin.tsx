import { Cell } from '@shroomap/ui/cmp-014/gallery-demos';
import { AdminShellDemo } from '@shroomap/ui/cmp-031/gallery-demos';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-031',
  title: 'Admin shell (CMP-031)',
  order: 31,
};

const TOAST = [
  { id: 'saved', variant: 'success' as const, message: 'Settings saved.', critical: true },
];

export default function FeShellAdminSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="shell-admin">
      <Cell
        id="admin-sidebar"
        label="CMP-031 sidebar 240 px: portal tag, top rule, alert count badge, Back to workspace in the foot"
      >
        <AdminShellDemo layout="sidebar" alertCount={3} />
      </Cell>
      <Cell
        id="admin-nav-states"
        label="CMP-031 nav item states: current, hover (preview), default"
      >
        <AdminShellDemo
          layout="sidebar"
          path="/admin/usage"
          previewHover="settings"
          alertCount={3}
        />
      </Cell>
      <Cell id="admin-no-alerts" label="CMP-031 no unacknowledged alerts: no badge">
        <AdminShellDemo layout="sidebar" path="/admin/alerts" />
      </Cell>
      <Cell id="admin-many-alerts" label="CMP-031 alert count capped at 99+">
        <AdminShellDemo layout="sidebar" alertCount={140} />
      </Cell>
      <Cell id="admin-rail" label="CMP-031 collapsed rail 64 px: alert count becomes a dot">
        <AdminShellDemo layout="rail" alertCount={3} />
      </Cell>
      <Cell id="admin-tabbar" label="CMP-031 bottom tab bar, five items (under 768 px)">
        <AdminShellDemo layout="tabbar" path="/admin/alerts" alertCount={3} />
      </Cell>
      <Cell id="admin-menu" label="CMP-031 avatar menu open: Switch to workspace">
        <AdminShellDemo menuOpen alertCount={3} />
      </Cell>
      <Cell id="admin-toast" label="CMP-031 toast region with a toast (top right)">
        <AdminShellDemo toasts={TOAST} />
      </Cell>
      <Cell id="admin-nav-disabled" label="CMP-031 nav item disabled (Usage report)">
        <AdminShellDemo layout="sidebar" previewDisabled="usage" alertCount={3} />
      </Cell>
      <Cell id="admin-nav-focus" label="CMP-031 focus ring on a nav item (Invitations)">
        <AdminShellDemo layout="sidebar" previewFocus="invitations" alertCount={3} />
      </Cell>
      <Cell
        id="admin-unavailable"
        label="CMP-031 unavailable state for a non-admin (403): no navigation"
      >
        <AdminShellDemo layout="sidebar" unavailable />
      </Cell>
      <Cell
        id="admin-auto"
        label="CMP-031 responsive (follows the viewport: tab bar, rail, sidebar)"
      >
        <AdminShellDemo layout="auto" path="/admin/invitations" alertCount={3} />
      </Cell>
    </div>
  );
}
