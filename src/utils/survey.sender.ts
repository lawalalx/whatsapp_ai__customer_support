import { SendSurveyQuestionParams } from "../flow.types.js"
import { sendWhatsAppList, sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppTemplate, sendWhatsAppTyping } from "../whatsapp-client.js"
import { setLastOutbound } from './outboundTracker.js'

export async function sendSurveyIntro({
  to,
  phoneNumberId,
  surveyIntroTemplateId,
}: {
  to: string;
  phoneNumberId?: string;
  surveyIntroTemplateId?: string;
}) {
  const introText = `📊 *Dear Valued Customer,*\n\nWelcome to the *FBNBank Customer Survey*.\n\nPlease help us fill out this quick survey. Your feedback is incredibly important to us and helps us improve our services for you! 🌟\n\n⏱️ *Time:* Less than 2 minutes\n🛑 _Type *EXIT* at any time to stop._`;

  // Track intro as survey outbound so a typed "proceed" is routed to survey handler.
  setLastOutbound(to, 'survey_question');

  const proactiveTemplate = surveyIntroTemplateId || process.env.WHATSAPP_PROACTIVE_TEMPLATE;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';

  if (proactiveTemplate) {
    console.log('Attempting proactive template for survey intro:', proactiveTemplate);
    const templateSent = await sendWhatsAppTemplate({
      to,
      templateId: proactiveTemplate,
      phoneNumberId,
      templateData: {
        body: [
          `${introText}\n\nReply "Proceed" to start.`,
        ],
      },
    });
    if (templateSent) {
      return true;
    }

    console.warn('Proactive intro template send failed; falling back to interactive Proceed intro card.');
  }

  return sendWhatsAppSurvey({
    to,
    question: introText,
    options: [{ id: 'survey_intro_proceed', title: 'Proceed' }],
    headerText: 'Survey',
    footerText: 'Click the button below to proceed',
    phoneNumberId,
  });
}

export async function sendSurveyQuestion({
  to,
  session,
  question,
  phoneNumberId,
}: SendSurveyQuestionParams) {

  if (!session) {
    console.error("❌ Missing session in sendSurveyQuestion")
    return false
  }

  const index = session.current_question;
  const total = session.total_questions;
        
  const footerText = `Question ${index + 1} of ${total}`;

  let qText = question.text ?? question.question;
  if (!qText) return false;

  const headerText = index === 0 ? "FBNBank Survey" : undefined;

  // If this is the first question of a proactively-started session, use
  // a pre-approved WhatsApp template to avoid the 24-hour re-engagement block.
  const proactiveTemplate = process.env.WHATSAPP_PROACTIVE_TEMPLATE;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
  
  if ((session?.current_question === 0 || session?.current_question === undefined) && proactiveTemplate) {
    console.log('Using proactive template for first question:', proactiveTemplate);

    const templateSent = await sendWhatsAppTemplate({
      to,
      templateId: proactiveTemplate,
      phoneNumberId,
      templateData: {
        body: [
          `${qText}\n\n${footerText}`,
        ],
      },
    });

    if (templateSent) {
      return true;
    }

    console.warn('First-question template send failed; falling back to standard survey question delivery.');
  }

  // Prefer interactive when options are present.
  const opts = question.options ?? [];
  const hasOptions = Array.isArray(opts) && opts.length > 0;

  if (hasOptions) {
    const useButtons = question.type === 'button' || (question.type === undefined && opts.length <= 2);
    const useList = question.type === 'list' || (question.type === undefined && opts.length > 2);

    // Mark outbound
    setLastOutbound(to, 'survey_question');

    if (useButtons) {
      return sendWhatsAppSurvey({
        to,
        question: qText,
        options: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
        headerText,
        footerText,
        phoneNumberId,
      });
    }

    if (useList) {
      return sendWhatsAppList({
        to,
        headerText,
        bodyText: qText, 
        footerText,
        buttonText: 'Select',
        phoneNumberId,
        sections: [
          {
            title: question.sectionTitle || 'Options',
            rows: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
          },
        ],
      });
    }
  }

  // TEXT FALLBACK (FIXED)
  setLastOutbound(to, 'survey_question');
  
  return sendWhatsAppMessage({
    to,
    message: `${qText}\n\n${footerText}\n(Reply with your answer)`,
    phoneNumberId,
  });
}
