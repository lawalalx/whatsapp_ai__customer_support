import 'dotenv/config';
import assert from 'assert';

import escalationService from '../services/escalation-service';

// Simple in-memory DB mock
function makeMockDb() {
  const rows: any[] = [];
  return {
    any: async (query: string, params?: any[]) => {
      const q = query.toLowerCase();
      if (q.startsWith('select') && q.includes('from escalation where ticket_id =')) {
        const ticketId = params?.[0];
        return rows.filter(r => r.ticket_id === ticketId);
      }
      if (q.startsWith('select') && q.includes('where ticket_status')) {
        const status = params?.[0];
        return rows.filter(r => r.ticket_status === status);
      }
      if (q.startsWith('select')) return rows;
      if (q.startsWith('update')) {
        const status = params?.[0];
        const ticketId = params?.[1];
        let updated: any = null;
        for (const r of rows) {
          if (r.ticket_id === ticketId) { r.ticket_status = status; updated = r; }
        }
        return updated ? [updated] : [];
      }
      if (q.startsWith('insert into escalation')) {
        const [message, category, ticket_status, ticket_id, customer_phone] = params || [];
        const rec = { id: rows.length + 1, message, category, ticket_status, ticket_id, customer_phone };
        rows.push(rec);
        return [];
      }
      return [];
    }
  } as any;
}

async function runTests() {
  console.log('Running escalation service tests...');

  // getEscalations
  const db = makeMockDb();
  // seed a ticket
  await db.any('INSERT INTO escalation (message, category, ticket_status, ticket_id, customer_phone) VALUES ($1,$2,$3,$4,$5)', ['hi','enquiry','pending','T1','2348000000000']);

  const all = await escalationService.getEscalations(db);
  assert(Array.isArray(all) && all.length === 1, 'should return seeded ticket');

  const pending = await escalationService.getEscalations(db, 'pending');
  assert(Array.isArray(pending) && pending.length === 1, 'should filter by status');

  // updateTicketStatus
  const updated = await escalationService.updateTicketStatus(db, 'T1', 'completed');
  assert(updated && updated.ticket_status === 'completed', 'status should update');

  // notifyAndMaybeUpdate: requires to or ticketId with phone
  let notified = await escalationService.notifyAndMaybeUpdate({ db, ticketId: 'T1', ticketStatus: 'completed', sendMessage: async (to:number|string, msg:string) => { return true; } as any });
  assert(notified.sent === true, 'should send notification and return sent=true');

  // require phone when ticket not found
  let threw = false;
  try {
    await escalationService.notifyAndMaybeUpdate({ db, message: 'hello' });
  } catch (e:any) {
    threw = true;
  }
  assert(threw, 'should throw when no customer_phone provided');

  console.log('All escalation service tests passed');
}

runTests().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
