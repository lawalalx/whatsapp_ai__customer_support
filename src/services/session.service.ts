// services/session.service.ts
import type { Pool } from 'pg';

export async function getActiveSurveySession(db: Pool, phone: string) {
  const result = await db.query(
    `SELECT * FROM survey_sessions
     WHERE customer_phone = $1
     AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [phone]
  );

  console.log(`\n\nChecked active session for phone ${phone}. Found: ${result.rows.length > 0}`);
  console.log("LOOKUP PHONE:", phone);
  console.log("SESSION RESULT:", result.rows);
  return result.rows[0];
}

export async function updateSessionProgress(db: Pool, sessionId: string, nextIndex: number) {
  const result = await db.query(
    `UPDATE survey_sessions
     SET current_question = $1, updated_at = NOW()
     WHERE id = $2`,
    [nextIndex, sessionId]
  );
  console.log(`\n\nSession ${sessionId} moved to question index ${nextIndex}.`);
  return result;
}


export async function completeSession(db: Pool, sessionId: string) {
  // Mark the given session as completed
  const result = await db.query(
    `UPDATE survey_sessions
     SET status = 'completed', updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
  console.log(`\n\nSession ${sessionId} marked as completed.`);

  // Also defensively mark any other active sessions for the same phone
  // as completed to avoid multiple active sessions for one customer_phone
  // (this is a pragmatic safeguard for edge cases / previous bugs).
  try {
    await db.query(
      `UPDATE survey_sessions
       SET status = 'completed', updated_at = NOW()
       WHERE customer_phone = (
         SELECT customer_phone FROM survey_sessions WHERE id = $1
       )
       AND status = 'active'
       AND id <> $1`,
      [sessionId]
    );
    console.log(`\n\nOther active sessions for session ${sessionId} customer marked completed.`);
  } catch (e) {
    console.warn('Failed to cleanup other active sessions for', sessionId, e);
  }

  return result;
}
