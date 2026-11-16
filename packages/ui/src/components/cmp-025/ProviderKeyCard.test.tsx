// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { KeyCardDemo } from './gallery-demos';
import { KEY_CARD_STATES, PROVIDERS, PROVIDER_NAMES, ProviderKeyCard } from './index';

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
            fingerprint="sha256:9c1e"
            lastTested="12 Nov 2026"
            eventTrailHref="#events"
          />,
        );
        const name = PROVIDER_NAMES[provider];
        expect(screen.getByRole('heading', { name })).toBeInTheDocument();
        expect(container.firstElementChild).toHaveAttribute('data-state', state);
        expect(await axeViolations(container)).toEqual([]);
      });
    }
  }

  it('names actions per provider and has no reveal control', () => {
    render(<ProviderKeyCard provider="wavespeed" state="active" hint="a3f9" eventTrailHref="#e" />);
    expect(screen.getByRole('button', { name: 'Replace WaveSpeed key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete WaveSpeed key' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'WaveSpeed key events' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show|reveal|copy/i })).toBeNull();
    expect(screen.getByTestId('key-hint')).toHaveClass('font-mono');
    expect(screen.getByTestId('key-hint')).toHaveTextContent('…a3f9');
  });

  it('shows Add for none, and disables actions while testing', () => {
    const { rerender } = render(<ProviderKeyCard provider="openai" state="none" />);
    expect(screen.getByRole('button', { name: 'Add OpenAI key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    rerender(<ProviderKeyCard provider="openai" state="testing" />);
    expect(screen.getByRole('button', { name: 'Replace OpenAI key' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Testing OpenAI key');
    expect(screen.getByText('Not tested yet')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Replace WaveSpeed key' })).toBeInTheDocument();
  });
});
