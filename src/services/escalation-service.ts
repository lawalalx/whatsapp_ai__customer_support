import { sendWhatsAppMessage as sendWA } from '../whatsapp-client';

export async function getEscalations(db: any, status?: string) {
  if (status) {
    return await db.any('SELECT * FROM escalations WHERE ticket_status = $1 ORDER BY created_at DESC', [status]);
  }
  return await db.any('SELECT * FROM escalations  ORDER BY created_at DESC');
}

export async function updateTicketStatus(db: any, ticketId: string, ticketStatus: string) {
  const res = await db.any('UPDATE escalations  SET ticket_status = $1, updated_at = NOW() WHERE ticket_id = $2 RETURNING *', [ticketStatus, ticketId]);
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

export interface NotifyParams {
  db: any;
  ticketId?: string;
  ticketStatus?: string;
  to?: string;
  message?: string;
  sendMessage?: (to: string, message: string) => Promise<boolean>;
}

export async function notifyAndMaybeUpdate(params: NotifyParams) {
  const { db, ticketId, ticketStatus } = params;
  let { to, message } = params;
  
  const sendMessage: (to: string, message: string) => Promise<boolean> = params.sendMessage ?? (async (to: string, message: string) => {
    return await sendWA({ to, message });
  });

  if (ticketId && ticketStatus) {
    const allowed = ['pending', 'completed'];
    if (!allowed.includes(ticketStatus)) throw new Error('Invalid ticketStatus');
    const updated = await updateTicketStatus(db, ticketId, ticketStatus);
    if (!to && updated && updated.customer_phone) to = updated.customer_phone;
  }

  if (!to) {
    // If ticketId provided but no phone, try lookup
    if (ticketId) {
      const rows = await db.any('SELECT * FROM escalations WHERE ticket_id = $1', [ticketId]);
      const ticket = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      if (ticket && ticket.customer_phone) to = ticket.customer_phone;
    }
  }

  if (!to) {
    throw new Error('customer_phone (to) is required');
  }

  if (!message) {
    message = ticketId || ticketStatus ? `Update: ticket ${ticketId || ''} status ${ticketStatus || ''}`.trim() : 'Notification from support team.';
  }

  const sent = await sendMessage(to, message);
  return { sent, to, message };
}

export default {
  getEscalations,
  updateTicketStatus,
  notifyAndMaybeUpdate,
};
