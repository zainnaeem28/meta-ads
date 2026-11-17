import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { DomainError, parseWith } from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { BriefService } from '../application/brief.service.js';
import type { BriefView } from '../application/brief.service.js';
import type { GenerationJobRecord, IssueRecord } from '../application/brief-ports.js';

const Params = z.object({ campaignId: z.uuid() });
/** BriefPatch: closed, one to four segments, each with a position and at least one text. */
const BriefPatch = z.strictObject({
  segments: z
    .array(
      z
        .strictObject({
          position: z.number().int().min(1).max(4),
          dialogue: z.string().min(1).max(600).optional(),
          prompt: z.string().min(1).max(2000).optional(),
        })
        .refine((segment) => segment.dialogue !== undefined || segment.prompt !== undefined, {
          message: 'Send dialogue or prompt.',
        }),
    )
    .min(1)
    .max(4),
});

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
export function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

/** `If-Match: "<version>"`, the ETag of the last read (ADR-010: a mismatch is 409, not 412). */
export function versionOf(header: string | undefined): number {
  const match = header === undefined ? null : /^"([0-9]{1,9})"$/.exec(header.trim());
  if (match?.[1] === undefined || Number(match[1]) < 1) {
    throw new DomainError('validation_failed', 'The request is not valid.', [
      {
        field: 'If-Match',
        code: header === undefined ? 'required' : 'invalid_format',
        message: 'Send the ETag of the last read, e.g. "3".',
      },
    ]);
  }
  return Number(match[1]);
}

/** The signed-in account of a request; the session guard has already refused every other case. */
export function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

const LABELS: Record<string, string> = {
  pending: 'pending',
  submitting: 'queued',
  submitted: 'created',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

const jobView = (job: GenerationJobRecord) => ({
  id: job.id,
  state: job.state,
  label: LABELS[job.state] ?? 'pending',
  causeClass: job.causeClass,
  causeMessage: job.causeMessage,
  createdAt: instant(job.createdAt),
  updatedAt: instant(job.updatedAt),
  deadlineAt: instant(job.deadlineAt),
  reused: false,
});

export const issueView = (issue: IssueRecord) => ({
  id: issue.id,
  segmentPosition: issue.segmentPosition,
  field: issue.field,
  ruleId: issue.ruleId,
  class: issue.class,
  resolution: issue.resolution,
  message: issue.message,
  span:
    issue.spanStart === null || issue.spanEnd === null
      ? null
      : { start: issue.spanStart, end: issue.spanEnd },
  clearReason: issue.clearReason,
});

const view = ({ brief, generationJob, segments, issues }: BriefView) => ({
  id: brief.id,
  campaignId: brief.campaignId,
  state: brief.state,
  version: brief.version,
  acceptedAt: brief.acceptedAt === null ? null : instant(brief.acceptedAt),
  generationJob: generationJob === null ? null : jobView(generationJob),
  segments: segments.map((segment) => ({
    position: segment.position,
    state: segment.state,
    revision: segment.revision,
    dialogue: segment.dialogue,
    prompt: segment.prompt,
    wordCount: segment.wordCount,
  })),
  issues: issues.map(issueView),
  updatedAt: instant(brief.updatedAt),
});

const send = (reply: FastifyReply, result: BriefView) => {
  void reply.header('ETag', `"${String(result.brief.version)}"`);
  return view(result);
};

/** API-050 to API-052: the brief of one of my campaigns. Regenerate (API-053) is the next slice. */
@Controller('campaigns/:campaignId/brief')
@Scope('U')
export class BriefController {
  constructor(@Inject(BriefService) private readonly briefs: BriefService) {}

  @Get()
  async get(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { campaignId } = parseWith(Params, rawParams);
    return send(reply, await this.briefs.get(owner(actor), campaignId));
  }

  @Patch()
  async edit(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const ownerId = owner(actor);
    const { campaignId } = parseWith(Params, rawParams);
    const expected = versionOf(ifMatch);
    const body = parseWith(BriefPatch, rawBody);
    return send(
      reply,
      await this.briefs.edit(
        ownerId,
        campaignId,
        expected,
        body.segments.map((segment) => ({
          position: segment.position,
          ...(segment.dialogue === undefined ? {} : { dialogue: segment.dialogue }),
          ...(segment.prompt === undefined ? {} : { prompt: segment.prompt }),
        })),
      ),
    );
  }

  @Post('accept')
  @HttpCode(200)
  async accept(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const ownerId = owner(actor);
    const { campaignId } = parseWith(Params, rawParams);
    return send(reply, await this.briefs.accept(ownerId, campaignId, versionOf(ifMatch)));
  }
}
