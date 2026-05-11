import { Client } from 'pg';
(async ()=>{
  const phone = process.argv[2] || '2348163649273';
  const c = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/senegaldb' });
  await c.connect();
  try {
    const s = await c.query(`SELECT * FROM survey_sessions WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone]);
    console.log('LATEST SESSION:', JSON.stringify(s.rows[0]||null, null, 2));
    if (!s.rows[0]) return;
    const sid = s.rows[0].id;
    const r = await c.query(`SELECT * FROM survey_responses WHERE session_id=$1 ORDER BY created_at`, [sid]);
    console.log('RESPONSES:', JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await c.end();
  }
})();
