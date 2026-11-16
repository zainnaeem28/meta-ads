import { Alert, ALERT_VARIANTS } from '@shroomap/ui/cmp-011';
import { FormDemo } from '@shroomap/ui/cmp-010';
import { ToastDemo } from '@shroomap/ui/cmp-012';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-010',
  title: 'Form field, Alert, Toast (CMP-011, CMP-012)',
  order: 10,
};

export default function CompFormsSection() {
  return (
    <div className="flex flex-col gap-8" data-testid="comp-forms">
      <div data-testid="form-demo">
        <FormDemo />
      </div>
      <div data-testid="alerts" className="flex max-w-xl flex-col gap-3">
        {ALERT_VARIANTS.map((v) => (
          <Alert key={v} variant={v} title={`${v} alert`}>
            This message stays until the situation changes.
          </Alert>
        ))}
      </div>
      <div data-testid="toasts">
        <ToastDemo />
      </div>
    </div>
  );
}
