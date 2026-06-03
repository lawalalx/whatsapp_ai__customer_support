/**
 * meta-survey.service.ts
 *
 * Database operations for Meta WhatsApp Flow surveys and their responses.
 *
 * Tables:
 *   meta_flow_surveys   — registered surveys (one row per Meta Flow)
 *   meta_flow_responses — submissions received via the data endpoint webhook
 */

import { randomUUID } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetaFlowSurveyRow {
  id: string;
  flow_id: string;
  flow_name: string;
  survey_id: string | null;
  questions_data: any[];
  status: 'draft' | 'published' | 'deprecated';
  data_endpoint_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaFlowResponseRow {
  id: string;
  flow_id: string;
  flow_token: string;
  customer_phone: string | null;
  survey_id: string | null;
  responses: Record<string, any>;
  source: 'data_exchange' | 'nfm_reply';
  created_at: string;
}

// ─── Survey CRUD ─────────────────────────────────────────────────────────────

/** Insert or update a meta flow survey record */
export async function upsertMetaFlowSurvey(
  db: any,
  params: {
    flowId: string;
    flowName: string;
    surveyId?: string;
    questionsData: any[];
    status?: 'draft' | 'published' | 'deprecated';
    dataEndpointUrl?: string;
  },
): Promise<void> {
  const { flowId, flowName, surveyId, questionsData, status = 'draft', dataEndpointUrl } = params;

  // Try db.none (pg-promise style) first, fall back to db.query (node-postgres)
  const sql = `
    INSERT INTO meta_flow_surveys
      (id, flow_id, flow_name, survey_id, questions_data, status, data_endpoint_url, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (flow_id) DO UPDATE SET
      flow_name        = EXCLUDED.flow_name,
      survey_id        = EXCLUDED.survey_id,
      questions_data   = EXCLUDED.questions_data,
      status           = EXCLUDED.status,
      data_endpoint_url = EXCLUDED.data_endpoint_url,
      updated_at       = NOW()
  `;
  const values = [
    randomUUID(),
    flowId,
    flowName,
    surveyId ?? null,
    JSON.stringify(questionsData),
    status,
    dataEndpointUrl ?? null,
  ];

  if (typeof db.none === 'function') {
    await db.none(sql, values);
  } else {
    await db.query(sql, values);
  }
}

/** Mark a flow's status as published */
export async function markFlowPublished(db: any, flowId: string): Promise<void> {
  const sql = `UPDATE meta_flow_surveys SET status = 'published', updated_at = NOW() WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

/** Mark a flow's status as deprecated */
export async function markFlowDeprecated(db: any, flowId: string): Promise<void> {
  const sql = `UPDATE meta_flow_surveys SET status = 'deprecated', updated_at = NOW() WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

/** Retrieve all registered meta flow surveys */
export async function listMetaFlowSurveys(db: any) {
  const result = await db.query(`
    SELECT *
    FROM meta_flow_surveys
    WHERE is_archived = FALSE
    ORDER BY created_at DESC
  `);

  return result.rows;
}


/** Retrieve a single meta flow survey by its Meta flow_id */
export async function getMetaFlowSurveyByFlowId(
  db: any,
  flowId: string,
): Promise<MetaFlowSurveyRow | null> {
  const sql = `SELECT * FROM meta_flow_surveys WHERE flow_id = $1 LIMIT 1`;
  if (typeof db.oneOrNone === 'function') return db.oneOrNone(sql, [flowId]);
  const result = await db.query(sql, [flowId]);
  return result.rows[0] ?? null;
}

/** Delete a survey record from local DB (does not call Meta API) */
export async function deleteMetaFlowSurveyRecord(db: any, flowId: string): Promise<void> {
  const sql = `DELETE FROM meta_flow_surveys WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}


export async function archiveMetaFlowSurvey(db: any, flowId: string) {
  const result = await db.query(
    `
    UPDATE meta_flow_surveys
    SET
      is_archived = TRUE,
      archived_at = NOW(),
      updated_at = NOW()
    WHERE flow_id = $1
      AND is_archived = FALSE
    RETURNING flow_id
    `,
    [flowId]
  );

  return result.rows[0] ?? null;
}



/** Delete all responses for a flow from local DB */
export async function deleteMetaFlowResponsesByFlowId(db: any, flowId: string): Promise<void> {
  const sql = `DELETE FROM meta_flow_responses WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

// ─── Response CRUD ────────────────────────────────────────────────────────────

/** Save a response received from the data endpoint or nfm_reply webhook */
export async function saveMetaFlowResponse(
  db: any,
  params: {
    flowId: string;
    flowToken: string;
    customerPhone?: string;
    surveyId?: string;
    responses: Record<string, any>;
    source?: 'data_exchange' | 'nfm_reply';
  },
): Promise<void> {
  const { flowId, flowToken, customerPhone, surveyId, responses, source = 'data_exchange' } = params;

  const sql = `
    INSERT INTO meta_flow_responses
      (id, flow_id, flow_token, customer_phone, survey_id, responses, source, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (flow_token) DO UPDATE SET
      responses      = EXCLUDED.responses,
      customer_phone = COALESCE(EXCLUDED.customer_phone, meta_flow_responses.customer_phone),
      source         = EXCLUDED.source
  `;
  const values = [
    randomUUID(),
    flowId,
    flowToken,
    customerPhone ?? null,
    surveyId ?? null,
    JSON.stringify(responses),
    source,
  ];

  if (typeof db.none === 'function') {
    await db.none(sql, values);
  } else {
    await db.query(sql, values);
  }
}

/** Query meta flow responses with optional filters */
export async function queryMetaFlowResponses(
  db: any,
  params: {
    flowId?: string;
    customerPhone?: string;
    surveyId?: string;
    source?: string;
    from?: string; // ISO date string
    to?: string;   // ISO date string
    limit?: number;
    offset?: number;
  },
): Promise<MetaFlowResponseRow[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  const add = (col: string, val: any) => {
    values.push(val);
    conditions.push(`${col} = $${values.length}`);
  };

  if (params.flowId) add('flow_id', params.flowId);
  if (params.customerPhone) add('customer_phone', params.customerPhone);
  if (params.surveyId) add('survey_id', params.surveyId);
  if (params.source) add('source', params.source);

  if (params.from) {
    values.push(params.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (params.to) {
    values.push(params.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 50, 500);
  const offset = params.offset ?? 0;

  values.push(limit, offset);
  const sql = `
    SELECT * FROM meta_flow_responses
    ${where}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  if (typeof db.any === 'function') return db.any(sql, values);
  const result = await db.query(sql, values);
  return result.rows;
}

/** Count total responses (for pagination) */
export async function countMetaFlowResponses(
  db: any,
  params: { flowId?: string; customerPhone?: string; surveyId?: string },
): Promise<number> {
  const conditions: string[] = [];
  const values: any[] = [];

  const add = (col: string, val: any) => {
    values.push(val);
    conditions.push(`${col} = $${values.length}`);
  };

  if (params.flowId) add('flow_id', params.flowId);
  if (params.customerPhone) add('customer_phone', params.customerPhone);
  if (params.surveyId) add('survey_id', params.surveyId);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(*) AS total FROM meta_flow_responses ${where}`;

  if (typeof db.one === 'function') {
    const row = await db.one(sql, values);
    return Number(row.total);
  }
  const result = await db.query(sql, values);
  return Number(result.rows[0]?.total ?? 0);
}
