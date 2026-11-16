// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { JobCardGallery } from './gallery-demos';

afterEach(cleanup);

it('shows every job state, failure cause and QC state', () => {
  const { container } = render(<JobCardGallery />);
  expect(container.querySelectorAll('article')).toHaveLength(9);
  expect(screen.getAllByText('Failed')).toHaveLength(3);
  expect(screen.getByText('Check failed')).toBeInTheDocument();
  expect(screen.getByText('Check skipped')).toBeInTheDocument();
});
