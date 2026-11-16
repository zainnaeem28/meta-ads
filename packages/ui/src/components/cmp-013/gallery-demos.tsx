'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '../cmp-003';
import { Input } from '../cmp-004';
import { FormField } from '../cmp-010';
import { Menu } from '../cmp-020';
import { Dialog, DialogPanel } from './index';

const noop = () => {};
const PAUSE = 'Ads stop delivering within a few minutes. You can resume at any time.';

function NameField({ onChange }: { onChange?: () => void }) {
  return (
    <FormField label="Campaign name">
      {(control) => <Input {...control} defaultValue="Spring launch" onChange={onChange} />}
    </FormField>
  );
}

/** Gallery-only demos for CMP-013 and CMP-020; the gallery section imports them through `@shroomap/ui/cmp-013/gallery-demos`. */
export function DialogStates() {
  return (
    <>
      <DialogPanel inline title="Pause campaign?" description={PAUSE} confirmLabel="Pause campaign" onConfirm={noop} onCancel={noop} />
      <DialogPanel
        inline
        variant="typed-confirm"
        confirmText="Spring launch"
        title="Delete campaign"
        description="This removes the campaign and its reports. It cannot be undone."
        confirmLabel="Delete campaign"
        destructive
        onConfirm={noop}
        onCancel={noop}
      />
      <DialogPanel inline variant="form" title="Rename campaign" confirmLabel="Save name" onConfirm={noop} onCancel={noop}>
        <NameField />
      </DialogPanel>
      <DialogPanel inline title="Pause campaign?" description={PAUSE} confirmLabel="Pause campaign" pending onConfirm={noop} onCancel={noop} />
      <DialogPanel
        inline
        title="Pause campaign?"
        description={PAUSE}
        confirmLabel="Try again"
        error="We could not pause the campaign. Check your connection and try again."
        onConfirm={noop}
        onCancel={noop}
      />
      <DialogPanel
        inline
        variant="form"
        title="Rename campaign"
        confirmLabel="Save name"
        dirty
        discarding
        onConfirm={noop}
        onCancel={noop}
        onKeepEditing={noop}
        onDiscard={noop}
      >
        <NameField />
      </DialogPanel>
    </>
  );
}

/** Live dialog: one button per variant opens the real modal. */
export function DialogLive() {
  const [which, setWhich] = useState<'confirm' | 'typed-confirm' | 'form' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState('none');
  const close = () => {
    setWhich(null);
    setDirty(false);
  };
  const confirm = (name: string) => {
    setPending(true);
    setTimeout(() => {
      setPending(false);
      setLast(name);
      close();
    }, 300);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setWhich('confirm')}>
          Open confirm
        </Button>
        <Button variant="outline" onClick={() => setWhich('typed-confirm')}>
          Open typed confirm
        </Button>
        <Button variant="outline" onClick={() => setWhich('form')}>
          Open form dialog
        </Button>
      </div>
      <p className="text-caption" data-testid="dialog-result">
        Last confirmed: {last}
      </p>
      <Dialog
        open={which === 'confirm'}
        onClose={close}
        title="Pause campaign?"
        description={PAUSE}
        confirmLabel="Pause campaign"
        pending={pending}
        onConfirm={() => confirm('confirm')}
      />
      <Dialog
        open={which === 'typed-confirm'}
        onClose={close}
        variant="typed-confirm"
        confirmText="Spring launch"
        title="Delete campaign"
        description="This cannot be undone."
        confirmLabel="Delete campaign"
        destructive
        onConfirm={() => confirm('typed-confirm')}
      />
      <Dialog
        open={which === 'form'}
        onClose={close}
        variant="form"
        title="Rename campaign"
        confirmLabel="Save name"
        dirty={dirty}
        onConfirm={() => confirm('form')}
      >
        <NameField onChange={() => setDirty(true)} />
      </Dialog>
    </div>
  );
}

const ROW_ITEMS = [
  { id: 'edit', label: 'Edit' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'archive', label: 'Archive', disabled: true },
  { id: 'delete', label: 'Delete', destructive: true },
];

function MenuCell({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div
      data-cell={id}
      className="relative flex min-h-64 flex-col items-start gap-2 rounded-md border border-border bg-card p-4 text-foreground"
    >
      <span className="text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function MenuStates() {
  return (
    <>
      <MenuCell id="menu-account" label="CMP-020 account menu, open">
        <Menu
          label="Account"
          trigger="Account"
          header={
            <>
              <p className="font-semibold">Maya Chen</p>
              <p className="text-caption text-muted-foreground">maya@example.com</p>
            </>
          }
          items={[
            { id: 'settings', label: 'Settings' },
            { id: 'signout', label: 'Sign out' },
          ]}
          defaultOpen
        />
      </MenuCell>
      <MenuCell id="menu-row" label="CMP-020 row action menu, open (Archive disabled)">
        <Menu label="Actions for Spring launch" trigger="Actions" items={ROW_ITEMS} defaultOpen />
      </MenuCell>
      <MenuCell id="menu-focus" label="CMP-020 row action menu, first item focused">
        <Menu label="Actions for Summer sale" trigger="Actions" items={ROW_ITEMS} defaultOpen initialFocus />
      </MenuCell>
      <MenuCell id="menu-closed" label="CMP-020 closed (hover, open and focus by pointer or keyboard)">
        <Menu label="Actions for Autumn promo" trigger="Actions" items={ROW_ITEMS} />
      </MenuCell>
    </>
  );
}
