// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ClaimIssueGallery } from './gallery-demos';

afterEach(cleanup);

it('shows high risk, other and closed issues', () => {
  render(<ClaimIssueGallery />);
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
