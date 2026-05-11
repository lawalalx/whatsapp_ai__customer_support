import { Client } from 'pg';
(async ()=>{
  const c = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/senegaldb' });
  try {
    await c.connect();
    const sid = 'customer_satisfaction_1777275381431';
    const res = await c.query(`SELECT * FROM survey_sessions WHERE id = $1`, [sid]);
    console.log('SESSIONS:', JSON.stringify(res.rows, null, 2));
    const res2 = await c.query(`SELECT * FROM survey_responses WHERE session_id = $1`, [sid]);
    console.log('RESPONSES:', JSON.stringify(res2.rows, null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
