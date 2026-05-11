// Meta Flow API integration for WhatsApp (TypeScript only)
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';

const META_GRAPH_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const authHeader = { Authorization: `Bearer ${ACCESS_TOKEN}` };

export async function createMetaFlow(flowName: string) {
  const flowBaseUrl = `${META_GRAPH_URL}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/flows`;
  const flowCreationPayload = { name: flowName, categories: ['SURVEY'] };
  const res = await fetch(flowBaseUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(flowCreationPayload),
  });
  if (!res.ok) throw new Error(`Meta Flow creation failed: ${res.statusText}`);
  const data = await res.json() as any;
  return data.id;
}

export async function uploadFlowJson(flowId: string, jsonPath: string) {
  const graphAssetsUrl = `${META_GRAPH_URL}/${flowId}/assets`;
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', fs.createReadStream(jsonPath), 'survey.json');
  const res = await fetch(graphAssetsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload flow.json failed: ${res.statusText}`);
  return await res.json() as any;
}

export async function publishFlow(flowId: string) {
  const flowPublishUrl = `${META_GRAPH_URL}/${flowId}/publish`;
  const res = await fetch(flowPublishUrl, {
    method: 'POST',
    headers: authHeader,
  });
  if (!res.ok) throw new Error(`Publish flow failed: ${res.statusText}`);
  return await res.json();
}
