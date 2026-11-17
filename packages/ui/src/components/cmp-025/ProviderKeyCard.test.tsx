// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { KeyCardDemo } from './gallery-demos';
import {
  KEY_CARD_STATES,
  PROVIDERS,
  PROVIDER_NAMES,
  ProviderKeyCard,
  formatFingerprint,
} from './index';

afterEach(cleanup);

describe('CMP-025 Provider key card', () => {
  for (const provider of PROVIDERS) {
    for (const state of KEY_CARD_STATES) {
      it(`${provider} / ${state} renders and passes axe`, async () => {
        const { container } = render(
          <ProviderKeyCard
            provider={provider}
            state={state}
            hint="a3f9"
            fingerprint="4f9a1c07b21e"
            description="Used to generate the video clips."
            added="3 Nov 2026"
            lastUsed="12 min ago"
            jobsRunning={1}
          />,
        );
        const name = PROVIDER_NAMES[provider];
        expect(screen.getByRole('heading', { name })).toBeInTheDocument();
        expect(container.firstElementChild).toHaveAttribute('data-state', state);
        expect(await axeViolations(container)).toEqual([]);
      });
    }
  }

  it('puts status, Replace key and Delete in the title row, has no reveal control and no key-events link', () => {
    render(
      <ProviderKeyCard
        provider="wavespeed"
        state="active"
        hint="7Q2d"
        fingerprint="4f9a1c07b21e"
      />,
    );
    const heading = screen.getByRole('heading', { name: 'WaveSpeed' });
    const row = heading.parentElement as HTMLElement;
    expect(row).toContainElement(screen.getByText('Active'));
    expect(row).toContainElement(screen.getByRole('button', { name: 'Replace key' }));
    const del = screen.getByRole('button', { name: 'Delete WaveSpeed key' });
    expect(row).toContainElement(del);
    expect(del).toHaveTextContent('Delete');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /show|reveal|copy/i })).toBeNull();
    expect(screen.getByTestId('key-hint')).toHaveTextContent('…7Q2d');
  });

  it('renders the frame rows: description, key and fingerprint, Added, Last used, Jobs running', () => {
    render(
      <ProviderKeyCard
        provider="openai"
        state="active"
        description="Used for briefs."
        hint="7Q2d"
        fingerprint="4f9a1c07b21e"
        added="3 Nov 2026"
        lastUsed="12 min ago"
        jobsRunning={0}
      />,
    );
    expect(screen.getByText('Used for briefs.')).toBeInTheDocument();
    expect(screen.getByText('4f9a·1c07')).toBeInTheDocument();
    expect(formatFingerprint('b21e88d0aaaa')).toBe('b21e·88d0');
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['Key', 'Added', 'Last used', 'Jobs running']);
    expect(screen.getByText('3 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('12 min ago')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('reads Not yet when the key was never used', () => {
    render(<ProviderKeyCard provider="wavespeed" state="untested" hint="9fK2" lastUsed={null} />);
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('empty state: Not added badge, description and Add key button, no rows', () => {
    const { rerender } = render(
      <ProviderKeyCard
        provider="wavespeed"
        state="none"
        description="Used to generate the video clips."
      />,
    );
    expect(screen.getByText('Not added')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add WaveSpeed key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole('term')).toBeNull();
    rerender(<ProviderKeyCard provider="openai" state="testing" hint="a3f9" />);
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Testing OpenAI key');
  });

  it('delete confirmation moves focus to the safe choice and calls handlers', async () => {
    const user = userEvent.setup();
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();
    render(
      <ProviderKeyCard
        provider="openai"
        state="delete-confirm"
        hint="a3f9"
        onConfirmDelete={onConfirmDelete}
        onCancelDelete={onCancelDelete}
      />,
    );
    expect(screen.getByRole('button', { name: 'Keep OpenAI key' })).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}{Enter}');
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Keep OpenAI key' }));
    expect(onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it('demo walks active to delete-confirm to none', async () => {
    const user = userEvent.setup();
    render(<KeyCardDemo provider="openai" initial="active" />);
    await user.click(screen.getByRole('button', { name: 'Delete OpenAI key' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete OpenAI key' }));
    expect(screen.getByRole('button', { name: 'Add OpenAI key' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add OpenAI key' }));
    expect(screen.getByText('Untested')).toBeInTheDocument();
  });

  it('demo cancel returns to active', async () => {
    const user = userEvent.setup();
    render(<KeyCardDemo provider="wavespeed" initial="active" />);
    await user.click(screen.getByRole('button', { name: 'Delete WaveSpeed key' }));
    await user.click(screen.getByRole('button', { name: 'Keep WaveSpeed key' }));
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
  });
});
