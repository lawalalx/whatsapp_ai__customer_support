/**
 * WhatsApp Flow JSON Builder for Survey Flows
 *
 * Converts a simple survey definition (questions + options) into a valid
 * WhatsApp Flow JSON payload that can be uploaded to the Meta Flows API.
 *
 * Flow structure:
 *   INTRO  →  QUESTIONS  →  COMPLETE (terminal)
 *
 * The QUESTIONS screen submits via data_exchange to the server's
 * /webhook/meta-flow-data endpoint, which saves the responses and
 * navigates back to the COMPLETE terminal screen.
 *
 * Supported question types:
 *   "list"     → Dropdown selector       (best for 3-10 options)
 *   "button"   → RadioButtonsGroup       (best for 2-5 options)
 *   "text"     → TextInput (single-line)
 *   "textarea" → TextArea  (multi-line)
 *   "date"     → DatePicker
 */

export type QuestionType = 'list' | 'button' | 'text' | 'textarea' | 'date';

export interface MetaFlowQuestion {
  /** Unique identifier used as the form field name (no spaces, e.g. "q1" or "satisfaction") */
  id: string;
  /** The question text shown to the user */
  text: string;
  /**
   * Component type:
   * - "list"     → Dropdown
   * - "button"   → RadioButtonsGroup
   * - "text"     → TextInput
   * - "textarea" → TextArea
   * - "date"     → DatePicker
   */
  type: QuestionType;
  /** For list/button types: array of option strings */
  options?: string[];
  /** Whether the field is mandatory. Defaults to true */
  required?: boolean;
  /** Placeholder / helper text shown inside the component */
  placeholder?: string;
  /**
   * Section label for RadioButtonsGroup. If omitted, the question text is used.
   * RadioButtonsGroup requires a separate label attribute.
   */
  sectionTitle?: string;
}

export interface MetaFlowSurveyDefinition {
  /** Unique identifier for this survey definition (saved in meta_flow_surveys.survey_id) */
  id?: string;
  /** Human-readable survey name (max 30 chars used as screen title) */
  name: string;
  /** Short description shown on the INTRO screen */
  description?: string;
  /** Questions to include in the survey */
  questions: MetaFlowQuestion[];
  /** Message shown on the COMPLETE terminal screen. Defaults to a generic thanks message */
  thankYouText?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

/** Build the component tree for one question */
function buildQuestionComponent(q: MetaFlowQuestion): any[] {
  const components: any[] = [];
  const required = q.required !== false;

  switch (q.type) {
    case 'list': {
      if (!q.options || q.options.length === 0) {
        throw new Error(`Question "${q.id}" has type "list" but no options array`);
      }
      components.push({
        type: 'Dropdown',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        'data-source': q.options.map((opt, i) => ({
          id: `${q.id}_opt_${i}`,
          title: truncate(opt, 30),
        })),
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'button': {
      if (!q.options || q.options.length === 0) {
        throw new Error(`Question "${q.id}" has type "button" but no options array`);
      }
      components.push({
        type: 'RadioButtonsGroup',
        name: q.id,
        label: truncate(q.sectionTitle || q.text, 30),
        required,
        'data-source': q.options.map((opt, i) => ({
          id: `${q.id}_opt_${i}`,
          title: truncate(opt, 30),
        })),
      });
      break;
    }

    case 'textarea': {
      components.push({
        type: 'TextArea',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'date': {
      components.push({
        type: 'DatePicker',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'text':
    default: {
      components.push({
        type: 'TextInput',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        'input-type': 'text',
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }
  }

  return components;
}

// ─── Main Builder ─────────────────────────────────────────────────────────────

/**
 * Generates a WhatsApp Flow JSON object from a survey definition.
 *
 * @param def      Survey definition (name, description, questions, etc.)
 * @param dataEndpointUrl  Full HTTPS URL of your /webhook/meta-flow-data endpoint
 * @returns        Plain object ready for JSON.stringify and upload to Meta
 */
export function buildSurveyFlowJson(
  def: MetaFlowSurveyDefinition,
  dataEndpointUrl: string,
): object {
  if (!def.questions || def.questions.length === 0) {
    throw new Error('Survey must have at least one question');
  }
  if (!dataEndpointUrl || !dataEndpointUrl.startsWith('https://')) {
    throw new Error('dataEndpointUrl must be a valid HTTPS URL');
  }

  // Build the form components for QUESTIONS screen
  const formChildren: any[] = [];

  for (const q of def.questions) {
    // Add a question heading above every component for clarity
    formChildren.push({
      type: 'TextSubheading',
      text: truncate(q.text, 80),
    });
    formChildren.push(...buildQuestionComponent(q));
  }

  // Footer (Submit button) using data_exchange to send to our data endpoint
  const formPayload: Record<string, string> = {};
  for (const q of def.questions) {
    formPayload[q.id] = `\${form.${q.id}}`;
  }

  formChildren.push({
    type: 'Footer',
    label: 'Submit Responses',
    'on-click-action': {
      name: 'data_exchange',
      payload: formPayload,
    },
  });

  // return {
  //   version: '3.1',
  //   data_api_version: '3.0',
  //   data_channel_uri: dataEndpointUrl,
  //   routing_model: {
  //     INTRO: ['QUESTIONS'],
  //     QUESTIONS: ['COMPLETE'],
  //     COMPLETE: [],
  //   },
  return {
    version: '7.0',
    data_api_version: '3.0',
    routing_model: {
      INTRO: ['QUESTIONS'],
      QUESTIONS: ['COMPLETE'],
      COMPLETE: [],
    },
    screens: [
      // ─── INTRO ───────────────────────────────────────────────────────
      {
        id: 'INTRO',
        title: truncate(def.name, 30),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: truncate(def.name, 60),
            },
            {
              type: 'TextBody',
              text:
                def.description ||
                'Your feedback is important to us. This survey takes less than 2 minutes to complete.',
            },
            {
              type: 'TextCaption',
              text: `This survey has ${def.questions.length} question${def.questions.length !== 1 ? 's' : ''}.`,
            },
            {
              type: 'Footer',
              label: 'Start Survey',
              'on-click-action': {
                name: 'navigate',
                next: { type: 'screen', name: 'QUESTIONS' },
                payload: {},
              },
            },
          ],
        },
      },

      // ─── QUESTIONS ───────────────────────────────────────────────────
        // {
        //   id: 'QUESTIONS',
        //   title: 'Survey Questions',
        //   layout: {
        //     type: 'SingleColumnLayout',
        //     children: [
        //       {
        //         type: 'Form',
        //         name: 'survey_form',
        //         children: formChildren,
        //       },
        //     ],
        //   },
        // },


      {
        id: 'QUESTIONS',
        title: 'Survey Questions',
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...formChildren,
            {
              type: 'Footer',
              label: 'Submit Responses',
              'on-click-action': {
                name: 'data_exchange'
              }
            }
          ]
        }
      },

      // ─── COMPLETE (terminal) ─────────────────────────────────────────
      {
        id: 'COMPLETE',
        terminal: true,
        success: true,
        title: 'Thank You',
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: '🎉 Thank You!',
            },
            {
              type: 'TextBody',
              text:
                def.thankYouText ||
                'Your responses have been recorded. We truly appreciate your feedback!',
            },
            {
              type: 'Footer',
              label: 'Done',
              'on-click-action': {
                name: 'complete',
                payload: {},
              },
            },
          ],
        },
      },
    ],
  };
}
