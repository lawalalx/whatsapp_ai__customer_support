import 'dotenv/config';
import assert from 'assert';

import escalationService from '../services/escalation-service';

// Simple in-memory DB mock
function makeMockDb() {
  const rows: any[] = [];
  return {
    any: async (query: string, params?: any[]) => {
      const q = query.toLowerCase().trim();
      if (q.startsWith('select') && q.includes('from escalations where ticket_id =')) {
        const ticketId = params?.[0];
        return rows.filter(r => r.ticket_id === ticketId);
      }
      if (q.startsWith('select') && q.includes('regexp_replace(coalesce(handoff_phone, customer_phone')) {
        const customerPhone = params?.[0];
        const ticketStatus = params?.[1];
        const requiresHuman = q.includes('human_agent_active = true');
        const normalizedPhone = String(customerPhone ?? '').replace(/\D/g, '');
        return rows
          .filter(r => {
            const matchPhone = String(r.handoff_phone ?? r.customer_phone ?? '').replace(/\D/g, '') === normalizedPhone;
            return matchPhone && r.ticket_status === ticketStatus && (!requiresHuman || r.human_agent_active === true);
          })
          .slice(0, 1);
      }
      if (q.startsWith('select') && q.includes('customer_phone =') && q.includes('ticket_status =')) {
        const customerPhone = params?.[0];
        const ticketStatus = params?.[1];
        const requiresHuman = q.includes('human_agent_active = true');
        const normalizedPhone = String(customerPhone ?? '').replace(/\D/g, '');
        return rows
          .filter(r => {
            const matchPhone = String(r.handoff_phone ?? r.customer_phone ?? '').replace(/\D/g, '') === normalizedPhone;
            return matchPhone && r.ticket_status === ticketStatus && (!requiresHuman || r.human_agent_active === true);
          })
          .slice(0, 1);
      }
      if (q.startsWith('select') && q.includes('from escalation_messages')) {
        const ticketId = params?.[0];
        const direction = q.includes('direction =') ? params?.[1] : undefined;
        const limit = q.includes('direction =') ? params?.[2] : params?.[1];
        const messages = rows
          .filter(r => r._kind === 'message' && r.ticket_id === ticketId && (!direction || r.direction === direction))
          .sort((a, b) => (b.created_at_seq ?? 0) - (a.created_at_seq ?? 0));
        return messages.slice(0, Number(limit ?? 50));
      }
      if (q.startsWith('select') && q.includes('where ticket_status')) {
        const status = params?.[0];
        return rows.filter(r => r.ticket_status === status);
      }
      if (q.startsWith('select')) return rows;
      if (q.startsWith('update')) {
        let updated: any = null;
        if (q.includes('set human_agent_active =')) {
          const active = params?.[0];
          const ticketId = params?.[1];
          for (const r of rows) {
            if (r.ticket_id === ticketId) {
              r.human_agent_active = active;
              if (active) r.human_engaged_at = 'now';
              updated = r;
            }
          }
          return updated ? [updated] : [];
        }

        if (q.includes('set handoff_phone =')) {
          const handoffPhone = params?.[0];
          const ticketId = params?.[1];
          for (const r of rows) {
            if (r.ticket_id === ticketId) {
              r.handoff_phone = handoffPhone;
              updated = r;
            }
          }
          return updated ? [updated] : [];
        }

        const status = params?.[0];
        const ticketId = params?.[1];
        for (const r of rows) {
          if (r.ticket_id === ticketId) {
            r.ticket_status = status;
            if (status === 'completed') {
              r.human_agent_active = false;
            }
            updated = r;
          }
        }
        return updated ? [updated] : [];
      }
      if (q.startsWith('insert into escalation_messages')) {
        const [ticket_id, direction, message_text, customer_phone, source_message_id] = params || [];
        const rec = {
          id: rows.length + 1,
          _kind: 'message',
          ticket_id,
          direction,
          message_text,
          customer_phone,
          source_message_id,
          created_at_seq: rows.length + 1,
        };
        rows.push(rec);
        return [rec];
      }
      if (q.startsWith('insert into escalation')) {
        const [message, category, ticket_status, ticket_id, customer_phone] = params || [];
        const rec = { id: rows.length + 1, message, category, ticket_status, ticket_id, customer_phone, handoff_phone: null, human_agent_active: false, human_engaged_at: null };
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
  const sendMessageMock = async (_to: number | string, _msg: string) => true;
  let notified = await escalationService.notifyAndMaybeUpdate({ db, ticketId: 'T1', ticketStatus: 'completed', sendMessage: sendMessageMock as any });
  assert(notified.sent === true, 'should send notification and return sent=true');

  await db.any('INSERT INTO escalation (message, category, ticket_status, ticket_id, customer_phone) VALUES ($1,$2,$3,$4,$5)', ['need help','request','pending','T2','221770000000']);

  const activeTicket = await escalationService.getLatestActiveEscalationByPhone(db, '221770000000');
  assert(activeTicket && activeTicket.ticket_id === 'T2', 'should find active escalation by phone');

  const humanOwnedBeforeClaim = await escalationService.getLatestHumanOwnedEscalationByPhone(db, '221770000000');
  assert(humanOwnedBeforeClaim === null, 'queued escalation should not disable bot before human engagement');

  const humanReply = await escalationService.sendHumanAgentMessage({
    db,
    ticketId: 'T2',
    message: 'Hello from human support',
    sendMessage: async () => true,
  });
  assert(humanReply.sent === true, 'should send human agent message for active escalation');

  const claimedTicket = await escalationService.getEscalationByTicketId(db, 'T2');
  assert(claimedTicket?.human_agent_active === true, 'first human message should claim the escalation');
  assert(claimedTicket?.handoff_phone === '221770000000', 'human reply should set handoff phone used for suppression match');

  const humanOwnedAfterClaim = await escalationService.getLatestHumanOwnedEscalationByPhone(db, '221770000000');
  assert(humanOwnedAfterClaim?.ticket_id === 'T2', 'claimed escalation should now be human-owned');

  await escalationService.logEscalationMessage({
    db,
    ticketId: 'T2',
    direction: 'inbound',
    messageText: 'I need help with ATM',
    customerPhone: '+221 77 000 0000',
    sourceMessageId: 'wamid.XYZ',
  });

  const loggedInbound = await escalationService.getEscalationMessages(db, 'T2', 'inbound', 10);
  assert(loggedInbound.length >= 1, 'should fetch logged inbound escalation messages');

  const releasedTicket = await escalationService.setHumanAgentActive(db, 'T2', false);
  assert(releasedTicket?.human_agent_active === false, 'release should return conversation control to bot');

  let blockedCompleted = false;
  try {
    await escalationService.sendHumanAgentMessage({
      db,
      ticketId: 'T1',
      message: 'Should fail because completed',
      sendMessage: async () => true,
    });
  } catch (e: any) {
    blockedCompleted = e.message === 'ticket_not_active';
  }
  assert(blockedCompleted, 'should block human replies on completed escalations');

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
