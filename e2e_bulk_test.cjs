const http = require('http');

function postJson(path, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 10000,
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function run() {
  const number = '2348163649273';

  const modes = ['ai', 'manual', 'meta'];

  for (const mode of modes) {
    console.log('\n--- Testing single send-survey mode:', mode, '---');
    try {
      const res = await postJson('/api/crm/send-survey', {
        to: number,
        surveyId: 'test-e2e',
        topic: 'e2e-test',
        mode,
        context: 'e2e-run',
      });
      console.log('STATUS', res.status, 'BODY', res.body);
    } catch (e) {
      console.error('ERROR single', mode, e.message);
    }
  }

  for (const mode of modes) {
    console.log('\n--- Testing bulk bulk-send-survey mode:', mode, '---');
    try {
      const res = await postJson('/api/crm/bulk-send-survey', {
        surveyId: 'test-e2e-bulk',
        topic: 'e2e-bulk',
        mode,
        context: 'e2e-bulk-run',
        customers: [number],
      });
      console.log('STATUS', res.status, 'BODY', res.body);
    } catch (e) {
      console.error('ERROR bulk', mode, e.message);
    }
  }
}

run().then(()=>console.log('\nE2E tests complete')).catch((e)=>{console.error('Fatal', e); process.exit(1);});
