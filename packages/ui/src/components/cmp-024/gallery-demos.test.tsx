// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { SegmentEditorGallery } from './gallery-demos';

afterEach(cleanup);

it('shows every zone and an editable editor', async () => {
  const { container } = render(<SegmentEditorGallery />);
  expect(container.querySelectorAll('section[data-zone]')).toHaveLength(6);
  await userEvent.type(screen.getAllByLabelText('Segment 2 dialogue')[1]!, ' x');
  expect(container.querySelectorAll('[data-zone=blocked]')).toHaveLength(1);
});
