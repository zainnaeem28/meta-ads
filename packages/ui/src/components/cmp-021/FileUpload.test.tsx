// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileUpload,
  UPLOAD_MAX_BYTES,
  formatBytes,
  validateImageFile,
  type UploadItem,
} from './index';
import { UploadLiveDemo, UploadStatesDemo } from './gallery-demos';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const img = (name = 'a.png', type = 'image/png') => new File(['x'], name, { type });

describe('CMP-021 rules', () => {
  it('accepts the four image types and rejects others, oversize and empty', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(validateImageFile({ name: 'a', type, size: 10 })).toBeNull();
    }
    expect(validateImageFile({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toMatch(
      /Not supported/,
    );
    expect(
      validateImageFile({ name: 'a.png', type: 'image/png', size: UPLOAD_MAX_BYTES + 1 }),
    ).toMatch(/Too large/);
    expect(
      validateImageFile({ name: 'a.png', type: 'image/png', size: UPLOAD_MAX_BYTES }),
    ).toBeNull();
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/);
  });
  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('CMP-021 FileUpload', () => {
  it('zone is a labelled button that opens the picker; keyboard works', async () => {
    const user = userEvent.setup();
    render(<FileUpload items={[]} onFiles={vi.fn()} onRemove={vi.fn()} />);
    const zone = screen.getByRole('button', { name: /Upload an image/ });
    expect(zone).toHaveAccessibleDescription(/JPEG, PNG, WebP or GIF/);
    const input = screen.getByTestId('file-upload-input') as HTMLInputElement;
    expect(input.accept).toBe('image/jpeg,image/png,image/webp,image/gif');
    const click = vi.spyOn(input, 'click');
    await user.tab();
    expect(zone).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('picker selection splits accepted and rejected files', () => {
    const onFiles = vi.fn();
    const onRejected = vi.fn();
    render(<FileUpload items={[]} onFiles={onFiles} onRejected={onRejected} onRemove={vi.fn()} />);
    const good = img();
    const bad = img('label.pdf', 'application/pdf');
    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [good, bad] } });
    expect(onFiles).toHaveBeenCalledWith([good]);
    expect(onRejected).toHaveBeenCalledWith([
      { file: bad, reason: expect.stringMatching(/Not supported/) },
    ]);
  });

  it('drag-over changes state; drop hands files over; disabled ignores drops', () => {
    const onFiles = vi.fn();
    const { rerender } = render(<FileUpload items={[]} onFiles={onFiles} onRemove={vi.fn()} />);
    const zone = screen.getByRole('button', { name: /Upload an image/ });
    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute('data-state', 'drag-over');
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-state', 'idle');
    const file = img();
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    onFiles.mockClear();
    rerender(<FileUpload items={[]} onFiles={onFiles} onRemove={vi.fn()} disabled />);
    fireEvent.dragOver(screen.getByRole('button', { name: /Upload an image/ }));
    fireEvent.drop(screen.getByRole('button', { name: /Upload an image/ }), {
      dataTransfer: { files: [file] },
    });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('every row state shows status text; rejected shows the server reason; remove works', async () => {
    const onRemove = vi.fn();
    const items: UploadItem[] = [
      { id: '1', name: 'a.jpg', size: 1000, status: 'uploading', progress: 40 },
      { id: '2', name: 'b.png', size: 2000, status: 'processing' },
      { id: '3', name: 'c.gif', size: 3000, status: 'ready', previewUrl: '/c.gif' },
      { id: '4', name: 'd.png', size: 4000, status: 'rejected', reason: 'Server says no.' },
      { id: '5', name: 'e.png', size: 4000, status: 'rejected' },
    ];
    const { container } = render(
      <FileUpload items={items} onFiles={vi.fn()} onRemove={onRemove} />,
    );
    expect(screen.getByText('Uploading, 40%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Uploading a.jpg' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(screen.getByText('Processing', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText('Ready', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText('Rejected. Server says no.')).toBeInTheDocument();
    expect(
      screen.getByText('The file could not be used.', { selector: 'span.text-destructive' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Uploaded files' })).toHaveAttribute(
      'aria-live',
      'polite',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove d.png' }));
    expect(onRemove).toHaveBeenCalledWith('4');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('idle and drag-over pass axe', async () => {
    const { container } = render(
      <FileUpload items={[]} onFiles={vi.fn()} onRemove={vi.fn()} dragOver />,
    );
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe('CMP-021 gallery demos', () => {
  it('states demo renders every state', () => {
    render(<UploadStatesDemo />);
    for (const s of ['uploading', 'processing', 'ready', 'rejected']) {
      expect(document.querySelector(`li[data-status=${s}]`)).not.toBeNull();
    }
    expect(document.querySelector('[data-state=drag-over]')).not.toBeNull();
  });

  it('live demo walks a file to ready and lists a rejected file', () => {
    vi.useFakeTimers();
    render(<UploadLiveDemo />);
    const input = screen.getByTestId('file-upload-input');
    fireEvent.change(input, {
      target: { files: [img('ok.png'), img('x.pdf', 'application/pdf')] },
    });
    expect(document.querySelector('li[data-status=uploading]')).not.toBeNull();
    expect(document.querySelector('li[data-status=rejected]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('li[data-status=processing]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('li[data-status=ready]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove ok.png' }));
    expect(document.querySelector('li[data-status=ready]')).toBeNull();
  });
});
