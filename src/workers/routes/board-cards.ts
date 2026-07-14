// board-cards.ts · GET /api/v1/board-cards
//
// Authority: API_CONTRACT_V1.md §GET /api/v1/board-cards

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { CardStatus, BoardCardListOpts } from '../dal/types';

export interface BoardCardsEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface BoardCardsVariables extends AuthVariables {
  dal: DalAdapter;
}

export const boardCardsRoute = new Hono<{
  Bindings: BoardCardsEnv;
  Variables: BoardCardsVariables;
}>();

const VALID_CARD_STATUSES: ReadonlySet<CardStatus> = new Set([
  'open', 'in_progress', 'blocked', 'review', 'done', 'archived',
]);

boardCardsRoute.get('/board-cards', async (ctx) => {
  try {
    const { workspace_id, role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({
        error: 'client role cannot list board cards',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }

    const url = new URL(ctx.req.url);
    const project_id = url.searchParams.get('project_id');
    const lane = url.searchParams.get('lane') || undefined;
    const status = url.searchParams.get('status') as CardStatus | null;

    if (!project_id) {
      ctx.status(400);
      return ctx.json({
        error: 'project_id query param is required',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    if (status && !VALID_CARD_STATUSES.has(status)) {
      ctx.status(400);
      return ctx.json({
        error: `invalid status: ${status}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    const opts: BoardCardListOpts = {
      ...(lane ? { lane } : {}),
      ...(status ? { status } : {}),
    };

    const dal = ctx.get('dal');
    const board_cards = await dal.listBoardCards(workspace_id, project_id, opts);
    return ctx.json(withDataClass({ board_cards }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
