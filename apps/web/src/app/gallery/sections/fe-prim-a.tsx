import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from '@shroomap/ui/cmp-003';
import { Input, KeyInput, Textarea } from '@shroomap/ui/cmp-004';
import { Select } from '@shroomap/ui/cmp-005';
import { Checkbox, RadioCard, SegmentedControl, Switch } from '@shroomap/ui/cmp-006';
import { Icon } from '@shroomap/ui/icons';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-003-006',
  title: 'Primitives A: Button, Input and textarea, Select, Choice controls',
  order: 3,
};

/** One state of one variant: `data-cell` is the stable address used by tests and baselines. */
function Cell({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div
      data-cell={id}
      className="flex flex-col items-start gap-2 rounded-md border border-border bg-card p-4 text-foreground"
    >
      <span className="text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4 py-4">
      <h3 id={`${id}-h`} className="text-section font-semibold">
        {id} {title}
      </h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'destructive-outline',
];

function ButtonCells() {
  return (
    <Group id="CMP-003" title="Button">
      {VARIANTS.flatMap((v) => [
        <Cell
          key={`${v}-default`}
          id={`CMP-003/${v}/default`}
          label={`${v}, default (hover, focus and active by interaction)`}
        >
          <Button variant={v}>Save changes</Button>
        </Cell>,
        <Cell key={`${v}-disabled`} id={`CMP-003/${v}/disabled`} label={`${v}, disabled`}>
          <Button variant={v} disabled>
            Save changes
          </Button>
        </Cell>,
        <Cell key={`${v}-pending`} id={`CMP-003/${v}/pending`} label={`${v}, pending`}>
          <Button variant={v} pending pendingLabel="Saving…">
            Save changes
          </Button>
        </Cell>,
      ])}
      <Cell id="CMP-003/small/default" label="small (32 px, 44 px on a phone)">
        <Button size="sm">Save</Button>
      </Cell>
      <Cell id="CMP-003/with-icon/default" label="label with icon">
        <Button variant="outline">
          <Icon name="download" size={16} />
          Download
        </Button>
      </Cell>
      <Cell id="CMP-003/icon-only/default" label="icon-only, default">
        <Button variant="icon-only" aria-label="Add item">
          <Icon name="plus" size={20} />
        </Button>
      </Cell>
      <Cell id="CMP-003/icon-only/disabled" label="icon-only, disabled">
        <Button variant="icon-only" aria-label="Delete item" disabled>
          <Icon name="trash-2" size={20} />
        </Button>
      </Cell>
      <Cell id="CMP-003/icon-only/pending" label="icon-only, pending">
        <Button variant="icon-only" aria-label="Add item, working" pending>
          <Icon name="plus" size={20} />
        </Button>
      </Cell>
      <Cell id="CMP-003/anchor/default" label="anchor (asChild)">
        <Button variant="secondary" asChild>
          <a href="#CMP-003-006">Back to top</a>
        </Button>
      </Cell>
    </Group>
  );
}

function FieldCells() {
  const error = (id: string, text: string) => (
    <p id={id} className="text-ui font-medium text-destructive">
      {text}
    </p>
  );
  return (
    <Group id="CMP-004" title="Input and textarea">
      <Cell id="CMP-004/text/empty" label="text, empty">
        <Input aria-label="Name, empty" placeholder="Campaign name" />
      </Cell>
      <Cell id="CMP-004/text/filled" label="text, filled">
        <Input aria-label="Name, filled" defaultValue="Morning Focus Blend" />
      </Cell>
      <Cell id="CMP-004/text/invalid" label="text, invalid">
        <Input aria-label="Name, invalid" defaultValue="" invalid aria-describedby="g-name-err" />
        {error('g-name-err', 'Enter a campaign name.')}
      </Cell>
      <Cell id="CMP-004/text/disabled" label="text, disabled">
        <Input aria-label="Name, disabled" defaultValue="Morning Focus Blend" disabled />
      </Cell>
      <Cell id="CMP-004/text/read-only" label="text, read-only">
        <Input aria-label="Name, read-only" defaultValue="Morning Focus Blend" readOnly />
      </Cell>
      <Cell id="CMP-004/textarea/empty" label="textarea with counter, empty">
        <Textarea
          id="g-ta-empty"
          aria-label="Brief, empty"
          maxLength={500}
          placeholder="What should the ad say?"
        />
      </Cell>
      <Cell id="CMP-004/textarea/filled" label="textarea with counter, filled">
        <Textarea
          id="g-ta-filled"
          aria-label="Brief, filled"
          maxLength={500}
          defaultValue="Calm, focused mornings with a mushroom blend."
        />
      </Cell>
      <Cell id="CMP-004/textarea/invalid" label="textarea, invalid (counter at the limit)">
        <Textarea
          id="g-ta-invalid"
          aria-label="Brief, invalid"
          maxLength={20}
          defaultValue="Twenty characters!!!"
          invalid
          aria-describedby="g-ta-err"
        />
        {error('g-ta-err', 'The brief is at its limit.')}
      </Cell>
      <Cell id="CMP-004/textarea/disabled" label="textarea, disabled">
        <Textarea
          id="g-ta-disabled"
          aria-label="Brief, disabled"
          maxLength={500}
          defaultValue="Locked brief."
          disabled
        />
      </Cell>
      <Cell id="CMP-004/textarea/read-only" label="textarea, read-only">
        <Textarea
          id="g-ta-ro"
          aria-label="Brief, read-only"
          maxLength={500}
          defaultValue="Read-only brief."
          readOnly
        />
      </Cell>
      <Cell id="CMP-004/key/empty" label="masked key input, empty">
        <KeyInput aria-label="Provider key, empty" placeholder="Paste the key" />
      </Cell>
      <Cell id="CMP-004/key/filled" label="masked key input, filled (never revealed)">
        <KeyInput aria-label="Provider key, filled" defaultValue="sk-fixture-0000" />
      </Cell>
      <Cell id="CMP-004/key/invalid" label="masked key input, invalid">
        <KeyInput
          aria-label="Provider key, invalid"
          defaultValue="bad"
          invalid
          aria-describedby="g-key-err"
        />
        {error('g-key-err', 'This key was not accepted.')}
      </Cell>
      <Cell id="CMP-004/key/disabled" label="masked key input, disabled">
        <KeyInput aria-label="Provider key, disabled" defaultValue="sk-fixture-0000" disabled />
      </Cell>
    </Group>
  );
}

function SelectCells() {
  const options = (
    <>
      <option value="">Choose a market</option>
      <option value="us">United States</option>
      <option value="de">Germany</option>
    </>
  );
  return (
    <Group id="CMP-005" title="Select">
      <Cell id="CMP-005/single/empty" label="single, empty">
        <Select aria-label="Market, empty" defaultValue="">
          {options}
        </Select>
      </Cell>
      <Cell id="CMP-005/single/filled" label="single, filled">
        <Select aria-label="Market, filled" defaultValue="de">
          {options}
        </Select>
      </Cell>
      <Cell id="CMP-005/single/invalid" label="single, invalid">
        <Select aria-label="Market, invalid" defaultValue="" invalid aria-describedby="g-sel-err">
          {options}
        </Select>
        <p id="g-sel-err" className="text-ui font-medium text-destructive">
          Choose a market.
        </p>
      </Cell>
      <Cell id="CMP-005/single/disabled" label="single, disabled">
        <Select aria-label="Market, disabled" defaultValue="de" disabled>
          {options}
        </Select>
      </Cell>
    </Group>
  );
}

function ChoiceCells() {
  return (
    <Group id="CMP-006" title="Choice controls">
      <Cell id="CMP-006/radio-card/default" label="radio card, default">
        <RadioCard
          name="g-mode"
          value="script"
          label="Write a script"
          description="Start from your own words."
        />
      </Cell>
      <Cell id="CMP-006/radio-card/checked" label="radio card, checked">
        <RadioCard
          name="g-mode-b"
          value="draft"
          label="Start from a draft"
          description="Let the director propose."
          defaultChecked
        />
      </Cell>
      <Cell id="CMP-006/radio-card/disabled" label="radio card, disabled">
        <RadioCard
          name="g-mode-c"
          value="import"
          label="Import a storyboard"
          description="Bring your own frames."
          unavailable
        />
      </Cell>
      <Cell id="CMP-006/checkbox/default" label="checkbox, default">
        <Checkbox label="Include captions" />
      </Cell>
      <Cell id="CMP-006/checkbox/checked" label="checkbox, checked">
        <Checkbox label="Include captions, on" defaultChecked />
      </Cell>
      <Cell id="CMP-006/checkbox/disabled" label="checkbox, disabled">
        <Checkbox label="Include captions, locked" disabled />
      </Cell>
      <Cell id="CMP-006/checkbox/unavailable" label="checkbox, not in this release">
        <Checkbox label="Auto-translate" unavailable />
      </Cell>
      <Cell id="CMP-006/segmented/default" label="segmented control (radio group)">
        <SegmentedControl
          aria-label="Aspect ratio"
          defaultValue="9:16"
          options={[
            { value: '9:16', label: '9:16' },
            { value: '1:1', label: '1:1' },
            { value: '16:9', label: '16:9', disabled: true },
          ]}
        />
      </Cell>
      <Cell id="CMP-006/switch/default" label="switch, off">
        <Switch label="Notify me" />
      </Cell>
      <Cell id="CMP-006/switch/checked" label="switch, on">
        <Switch label="Notify me, on" defaultChecked />
      </Cell>
      <Cell id="CMP-006/switch/disabled" label="switch, disabled">
        <Switch label="Notify me, locked" disabled />
      </Cell>
      <Cell id="CMP-006/switch/unavailable" label="switch, not in this release">
        <Switch label="Share to team" unavailable />
      </Cell>
    </Group>
  );
}

export default function PrimitivesASection() {
  return (
    <div data-testid="prim-a">
      <ButtonCells />
      <FieldCells />
      <SelectCells />
      <ChoiceCells />
    </div>
  );
}
