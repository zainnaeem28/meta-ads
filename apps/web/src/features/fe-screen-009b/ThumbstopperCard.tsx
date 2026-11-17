'use client';

import {
  generateThumbstopper,
  getGetThumbstopperQueryKey,
  getMediaUrl,
  getThumbstopper,
  type ThumbstopperResponse,
} from '@shroomap/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { Alert } from '@shroomap/ui/cmp-011';
import { Card } from '@shroomap/ui/cmp-018';
import { Icon } from '@shroomap/ui/icons';
import { useEffect, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { resolveError } from '../../lib/errors';
import { mapErrorDetails, type ControlMap } from '../../lib/errors/details';
import { useJobPolling } from '../../lib/query/job-polling';
import { SCREEN_009B_COPY as COPY } from './copy';

const CALLOUT_ID = 'thumbstopper-callout';
const CALLOUT_MAX = 80;
const CONTROLS: ControlMap = {
  calloutText: { id: CALLOUT_ID, label: COPY.calloutLabel },
};

/** Optional thumbstopper (API-075 to start, API-076 to follow): call-out text, generating, ready, failed. */
export function ThumbstopperCard({
  campaignId,
  path,
  onReady,
}: {
  campaignId: string;
  path: string;
  /** Receives the finished frame's link, shown as the poster of the player. */
  onReady?: (url: string | undefined) => void;
}) {
  const client = useQueryClient();
  const key = getGetThumbstopperQueryKey(campaignId);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [failure, setFailure] = useState<unknown>(null);
  const [again, setAgain] = useState(false);
  const [idem] = useState(() => new IdempotencyKeys());

  const thumb = useJobPolling({
    query: {
      queryKey: key,
      queryFn: async ({ signal }) =>
        (await getThumbstopper(campaignId, { signal })).data as ThumbstopperResponse,
      retry: false,
    },
    getState: (d) => (d && d.data ? stateOf(d.data.state) : undefined),
  });
  const job = thumb.data?.data ?? null;
  const state = job ? stateOf(job.state) : null;

  const media = useQuery({
    queryKey: ['media-url', job?.outputMediaId],
    queryFn: async ({ signal }) =>
      ((await getMediaUrl(job!.outputMediaId!, { signal })).data as { data: { url: string } }).data
        .url,
    enabled: state === 'completed' && job?.outputMediaId != null,
    staleTime: 4 * 60_000,
    retry: false,
  });
  const imageUrl = media.data;
  // The frame is the opening hook: tell the player once its link is known.
  useEffect(() => onReady?.(imageUrl), [onReady, imageUrl]);

  const start = useMutation({
    mutationFn: async (calloutText: string) => {
      const body = { calloutText };
      const res = await generateThumbstopper(
        campaignId,
        body,
        idempotencyHeaders(idem.keyFor(body)),
      );
      idem.succeeded();
      return res;
    },
    onSuccess: (res) => {
      setFailure(null);
      setFieldError(undefined);
      setAgain(false);
      client.setQueryData(key, res.data);
    },
    onError: (error) => {
      const view = resolveError(error, { surface: 'context' });
      setFieldError(
        view.code === 'open_claim_issues'
          ? mapErrorDetails(view.details, CONTROLS).fieldErrors[CALLOUT_ID]
          : undefined,
      );
      setFailure(error);
    },
  });

  const submit = () => {
    const value = text.trim();
    if (value.length === 0) {
      setFailure(null);
      setFieldError(COPY.calloutRequired);
      return;
    }
    setFieldError(undefined);
    start.mutate(value);
  };

  const showForm = !job || again;
  const working = state === 'pending' || state === 'processing';

  return (
    <Card title={COPY.thumbTitle} headingLevel={2}>
      <div
        className="flex flex-col gap-3"
        data-thumb-state={working ? 'generating' : (state ?? 'none')}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-ui text-muted-foreground">{COPY.thumbIntro}</p>
          {working ? (
            <Badge variant="info">
              <Icon
                name="loader-circle"
                size={16}
                className="animate-spin motion-reduce:animate-none"
              />
              {COPY.generating}
            </Badge>
          ) : state === 'completed' ? (
            <Badge variant="success">
              <Icon name="circle-check" size={16} />
              {COPY.ready}
            </Badge>
          ) : (
            <Badge variant="neutral">{COPY.optional}</Badge>
          )}
        </div>

        {thumb.isError ? (
          <ErrorNotice
            error={thumb.error}
            surface="context"
            returnTo={path}
            retrying={thumb.isRefetching}
            onAction={() => void thumb.refetch()}
          />
        ) : null}
        {thumb.isPending ? <Alert variant="info" role="status" title={COPY.loadingThumb} /> : null}

        {working ? (
          <Alert variant="info" role="status">
            {COPY.generatingStatus}
          </Alert>
        ) : null}

        {state === 'completed' && job && !again ? (
          <div className="flex flex-col gap-2">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={COPY.readyAlt(job.calloutText)}
                className="aspect-9/16 w-full max-w-40 rounded-md border border-border object-cover"
              />
            ) : null}
            <p className="text-ui">{COPY.calloutShown(job.calloutText)}</p>
            <div>
              <Button variant="outline" size="sm" onClick={() => setAgain(true)}>
                {COPY.another}
              </Button>
            </div>
          </div>
        ) : null}

        {state === 'failed' && job && !again ? (
          <Alert
            variant="destructive"
            title={COPY.failedTitle}
            action={
              <Button variant="outline" size="sm" onClick={() => setAgain(true)}>
                {COPY.retry}
              </Button>
            }
          >
            {job.causeMessage ?? COPY.failedBody}
          </Alert>
        ) : null}

        {showForm && !working ? (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Alert variant="info">{COPY.thumbCost}</Alert>
            <FormField
              label={COPY.calloutLabel}
              mark="optional"
              help={COPY.calloutHelp}
              error={fieldError}
              id={CALLOUT_ID}
            >
              {(c) => (
                <Input
                  {...c}
                  value={text}
                  maxLength={CALLOUT_MAX}
                  autoComplete="off"
                  onChange={(e) => {
                    setText(e.target.value);
                    setFieldError(undefined);
                  }}
                />
              )}
            </FormField>
            {failure ? (
              <ErrorNotice
                error={failure}
                surface="context"
                call="job"
                controls={CONTROLS}
                returnTo={path}
                retrying={start.isPending}
                onAction={(a) => {
                  if (a === 'retry') submit();
                  else setFailure(null);
                }}
              />
            ) : null}
            <div>
              <Button
                type="submit"
                variant="outline"
                pending={start.isPending}
                pendingLabel={COPY.generating}
              >
                <Icon name="image" size={16} />
                {COPY.generate}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function stateOf(s: string): 'pending' | 'processing' | 'completed' | 'failed' {
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'cancelled') return 'failed';
  if (s === 'processing') return 'processing';
  return 'pending';
}
