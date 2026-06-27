import express from 'express';
import { z } from 'zod';

const router = express.Router();

const CONFIG_ID = 'feedback-survey';

async function ensureTable(db: any) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS feedback_survey_config (
      id TEXT PRIMARY KEY,
      survey_id TEXT,
      name TEXT,
      question TEXT,
      options JSONB,
      header_text TEXT,
      footer_text TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getConfig(db: any) {
  await ensureTable(db);
  const result = await db.query(`SELECT * FROM feedback_survey_config WHERE id = $1 LIMIT 1`, [CONFIG_ID]);
  const row = result.rows?.[0];
  if (!row) return { id: CONFIG_ID, surveyId: null, name: 'Automated Feedback Survey', question: 'How do you like our service?', options: ['Excellent', 'Good', 'Average', 'Poor'], headerText: 'Customer Feedback', footerText: 'Please share your opinion', active: true };
  return {
    id: row.id,
    surveyId: row.survey_id ?? null,
    name: row.name,
    question: row.question,
    options: Array.isArray(row.options) ? row.options : JSON.parse(row.options || '[]'),
    headerText: row.header_text ?? null,
    footerText: row.footer_text ?? null,
    active: row.active,
  };
}

async function upsertConfig(db: any, config: { surveyId?: string; name?: string; question?: string; options?: string[]; headerText?: string | null; footerText?: string | null; active?: boolean; }) {
  await ensureTable(db);
  const current = await getConfig(db);
  const next = {
    ...current,
    ...config,
    surveyId: config.surveyId ?? current.surveyId ?? null,
    options: Array.isArray(config.options) && config.options.length > 0 ? config.options : current.options,
  };

  await db.query(
    `INSERT INTO feedback_survey_config (id, survey_id, name, question, options, header_text, footer_text, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (id) DO UPDATE SET
       survey_id = EXCLUDED.survey_id,
       name = EXCLUDED.name,
       question = EXCLUDED.question,
       options = EXCLUDED.options,
       header_text = EXCLUDED.header_text,
       footer_text = EXCLUDED.footer_text,
       active = EXCLUDED.active,
       updated_at = NOW()`,
    [CONFIG_ID, next.surveyId, next.name, next.question, JSON.stringify(next.options), next.headerText ?? null, next.footerText ?? null, next.active ?? true]
  );

  return next;
}

const configSchema = z.object({
  id: z.string().optional(),
  surveyId: z.string().optional(),
  name: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  options: z.array(z.string().min(1)).optional(),
  headerText: z.string().nullable().optional(),
  footerText: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

router.get('/config', async (_req, res) => {
  try {
    const storage = (res.req.app.locals.mastra as any)?.getStorage?.() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const config = await getConfig(db);
    return res.json({ success: true, config });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/config', async (req, res) => {
  try {
    const parsed = configSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', details: parsed.error.format() });
    }

    const storage = (req.app.locals.mastra as any)?.getStorage?.() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const config = await upsertConfig(db, parsed.data);
    return res.status(200).json({ success: true, config });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
