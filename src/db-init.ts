// ─── Database Initialization Script ──────────────────────────────────────────
// Run this once to create the custom survey tables in PostgreSQL.
// Usage: npx tsx src/db-init.ts
//
// Mastra auto-creates its own tables (threads, messages, traces, etc.)
// but we need custom tables for survey tracking.
import pool from "./db";

export const initDatabase = async () => {

  try {
    console.log('🔧 Connecting to PostgreSQL...');
    const client = await pool.connect();

    console.log('📦 Initializing database...');

    // ───────────────────────────────────────────────────────────
    // Enable extension (for UUID if you switch later)
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);

    // ───────────────────────────────────────────────────────────
    // Survey Sessions Table
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_sessions (
        id                TEXT PRIMARY KEY,
        survey_id         TEXT NOT NULL,
        customer_phone    TEXT NOT NULL,

        current_question  INTEGER NOT NULL DEFAULT 0,
        total_questions   INTEGER NOT NULL,

        questions_data    JSONB NOT NULL DEFAULT '[]'::jsonb,

        status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'abandoned')),

        expires_at        TIMESTAMPTZ,

        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ───────────────────────────────────────────────────────────
    // Survey Responses Table
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_responses (
        id               TEXT PRIMARY KEY,
        survey_id        TEXT NOT NULL,
        session_id       TEXT NOT NULL,
        customer_phone   TEXT NOT NULL,

        question_text    TEXT,
        question_id      TEXT NOT NULL,

        response_text    TEXT NOT NULL,
        response_id      TEXT,

        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_session
          FOREIGN KEY (session_id)
          REFERENCES survey_sessions(id)
          ON DELETE CASCADE,

        CONSTRAINT unique_response_per_question
          UNIQUE (session_id, question_id)
      );
    `);

    // ───────────────────────────────────────────────────────────
    // Indexes (Performance critical)
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_active_session
      ON survey_sessions (customer_phone, status);

      CREATE INDEX IF NOT EXISTS idx_survey_sessions_survey_id
      ON survey_sessions (survey_id);

      CREATE INDEX IF NOT EXISTS idx_survey_responses_session_id
      ON survey_responses (session_id);

      CREATE INDEX IF NOT EXISTS idx_session_question
      ON survey_responses (session_id, question_id);

      CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_id
      ON survey_responses (survey_id);
    `);

      // ───────────────────────────────────────────────────────────
      // Escalation Table (for human handoff / tickets)
      // ───────────────────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS escalations (
          id              SERIAL PRIMARY KEY,
          ticket_id       TEXT UNIQUE NOT NULL,
          message         TEXT,
          category        TEXT CHECK (category IN ('complaint','enquiry','request')),
          ticket_status   TEXT NOT NULL DEFAULT 'pending' CHECK (ticket_status IN ('pending','completed')),
          customer_phone  TEXT,

          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_escalations_ticket_status
        ON escalations (ticket_status);

        CREATE INDEX IF NOT EXISTS idx_escalations_ticket_id
        ON escalations (ticket_id);

        CREATE INDEX IF NOT EXISTS idx_escalations_customer_phone
        ON escalations (customer_phone);
      `);

    // ───────────────────────────────────────────────────────────
    // Auto-update updated_at trigger
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'trigger_update_survey_sessions_updated_at'
        ) THEN
          CREATE TRIGGER trigger_update_survey_sessions_updated_at
          BEFORE UPDATE ON survey_sessions
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END;
      $$;
    `);


    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'trigger_update_escalations_updated_at'
        ) THEN
          CREATE TRIGGER trigger_update_escalations_updated_at
          BEFORE UPDATE ON escalations
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END;
      $$;
    `);

    client.release();

    console.log('✅ Database initialized successfully!');
    console.log('   Tables: survey_sessions, survey_responses, escalations');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
