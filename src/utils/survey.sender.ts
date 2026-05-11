import { SendSurveyQuestionParams } from "../flow.types"
import { sendWhatsAppList, sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppTemplate, sendWhatsAppTyping } from "../whatsapp-client"
import { setLastOutbound } from './outboundTracker'



export async function sendSurveyQuestion({
  to,
  session,
  question,
}: SendSurveyQuestionParams) {

    if (!session) {
        console.error("❌ Missing session in sendSurveyQuestion")
        return false
    }

    const index = session.current_question;
    const total = session.total_questions;

    const headerText =
        index === 0 ? `📊 FBNBank Survey\n💡 Type exit anytime to stop the survey.` : undefined;

    const footerText = `Question ${index + 1} of ${total}`;

    const qText = question.text ?? question.question;
    if (!qText) return false;

    // If this is the first question of a proactively-started session, use
    // a pre-approved WhatsApp template to avoid the 24-hour re-engagement block.
    const proactiveTemplate = process.env.WHATSAPP_PROACTIVE_TEMPLATE;
    const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
    if ((session?.current_question === 0 || session?.current_question === undefined) && proactiveTemplate) {
        console.log('Using proactive template for first question:', proactiveTemplate);
        // Pass the question text as a body parameter to the template
        return sendWhatsAppTemplate({
            to,
            templateName: proactiveTemplate,
            languageCode: templateLang,
            components: [
                {
                    type: 'body',
                    parameters: [{ type: 'text', text: `${qText}\n\n${footerText}` }],
                },
            ],
        });
    }

    // Prefer interactive when options are present. Use explicit `type` when provided,
    // otherwise infer: up to 3 options => buttons, more => list.
    const opts = question.options ?? [];
    const hasOptions = Array.isArray(opts) && opts.length > 0;

    if (hasOptions) {
            // historical behavior: treat >2 options as a list (sectionList) rather than buttons
        const useButtons = question.type === 'button' || (question.type === undefined && opts.length <= 2);
        const useList = question.type === 'list' || (question.type === undefined && opts.length > 2);

        // mark outbound
        setLastOutbound(to, 'survey_question');

        // send typing indicator before survey message
        try { sendWhatsAppTyping({ to }).catch(() => {}); } catch (e) {}

        if (useButtons) {
            return sendWhatsAppSurvey({
                to,
                question: qText,
                options: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
                headerText,
                footerText,
            });
        }

        if (useList) {
            return sendWhatsAppList({
                to,
                headerText,
                bodyText: qText,
                footerText,
                buttonText: 'Select',
                sections: [
                    {
                        title: question.sectionTitle || 'Options',
                        rows: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
                    },
                ],
            });
        }
    }

    // TEXT (FIXED)
    // mark outbound
    setLastOutbound(to, 'survey_question');
    try { sendWhatsAppTyping({ to }).catch(() => {}); } catch (e) {}
    return sendWhatsAppMessage({
        to,
        message: `${qText}\n\n${footerText}\n(Reply with your answer)`,
    });
}
