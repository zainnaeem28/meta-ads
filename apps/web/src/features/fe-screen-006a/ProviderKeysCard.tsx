'use client';

import {
  getListMyProviderKeysQueryKey,
  listMyProviderKeys,
  type ProviderKeyListResponse,
} from '@shroomap/contracts';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Card } from '@shroomap/ui/cmp-018';
import { COPY_KEYS_CARD as COPY } from './copy';

const LABEL = { openai: 'OpenAI', wavespeed: 'WaveSpeed' } as const;

/** Side-panel status of the operator's own provider keys (SCREEN-006 frame). */
export function ProviderKeysCard() {
  const keys = useQuery({
    queryKey: getListMyProviderKeysQueryKey(),
    retry: false,
    queryFn: async ({ signal }) =>
      (await listMyProviderKeys({ signal })).data as ProviderKeyListResponse,
  });
  const list = keys.data?.data ?? [];
  return (
    <Card variant="section" headingLevel={2}>
      <h2 className="text-body font-semibold">{COPY.title}</h2>
      {list.map((k) => {
        const ready = k.configured && k.status !== 'disabled';
        return (
          <div key={k.provider} className="flex items-center justify-between text-ui">
            <span>{LABEL[k.provider as keyof typeof LABEL] ?? k.provider}</span>
            <Badge
              variant={ready ? 'success' : 'warning'}
              icon={ready ? 'circle-check' : 'triangle-alert'}
            >
              {ready ? COPY.ready : COPY.missing}
            </Badge>
          </div>
        );
      })}
    </Card>
  );
}
