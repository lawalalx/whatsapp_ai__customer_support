# FBNBank WhatsApp Message Templates (For Meta Approval)

This document contains the JSON payloads required to create pre-approved WhatsApp message templates via the Meta Cloud API. These templates are required for initiating conversations with customers outside the 24-hour customer service window.

You can submit these via the [WhatsApp Manager](https://business.facebook.com/wa/manage/message-templates/) or via the API using the `POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates` endpoint.

---

## 1. Survey Invitation (Satisfaction Scale)
**Category:** `UTILITY`
**Name:** `survey_invitation_scale`
**Language:** `fr` (French for FBNBank Sénégal)

This template asks the first question of the survey and provides three interactive buttons for the customer to respond.

```json
{
  "name": "survey_invitation_scale",
  "category": "UTILITY",
  "language": "fr",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "FBNBank Sénégal 🏦"
    },
    {
      "type": "BODY",
      "text": "Bonjour {{1}} 👋,\n\nMerci d'avoir choisi FBNBank Sénégal.\n\nComment évaluez-vous la facilité du processus d'ouverture de compte aujourd'hui ?",
      "example": {
        "body_text": [
          ["Monsieur Diop"]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Votre avis nous aide à nous améliorer."
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Très satisfait 😊"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Moyen 😐"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Insatisfait 😞"
        }
      ]
    }
  ]
}
```

---

## 2. Survey Question (Yes/No)
**Category:** `UTILITY`
**Name:** `survey_question_yes_no`
**Language:** `fr`

This template is for binary questions, such as asking if the account opening time met expectations.

```json
{
  "name": "survey_question_yes_no",
  "category": "UTILITY",
  "language": "fr",
  "components": [
    {
      "type": "BODY",
      "text": "{{1}}\n\nLe délai d'ouverture de compte a-t-il été conforme à vos attentes ?",
      "example": {
        "body_text": [
          ["Question 2/3 :"]
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Oui ✅"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Non ❌"
        }
      ]
    }
  ]
}
```

---

## 3. Survey Follow-up (Open-ended)
**Category:** `UTILITY`
**Name:** `survey_followup_open`
**Language:** `fr`

Used when a customer answers negatively and you want to ask "Why?".

```json
{
  "name": "survey_followup_open",
  "category": "UTILITY",
  "language": "fr",
  "components": [
    {
      "type": "BODY",
      "text": "Nous sommes désolés d'apprendre cela. 😔\n\nPourriez-vous nous dire pourquoi, afin que nous puissions améliorer nos services ? (Veuillez taper votre réponse ci-dessous)"
    }
  ]
}
```

---

## 4. Survey Completion (Thank You)
**Category:** `UTILITY`
**Name:** `survey_completion_thanks`
**Language:** `fr`

Sent at the end of the survey flow.

```json
{
  "name": "survey_completion_thanks",
  "category": "UTILITY",
  "language": "fr",
  "components": [
    {
      "type": "BODY",
      "text": "Merci beaucoup pour votre temps et vos commentaires précieux ! 🙏\n\nSi vous avez d'autres questions sur nos services, n'hésitez pas à nous écrire ici.\n\nPassez une excellente journée ! 🌟"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Parler à un agent 👤"
        },
        {
          "type": "URL",
          "text": "Visiter notre site 🌐",
          "url": "https://www.fbnbanksenegal.com"
        }
      ]
    }
  ]
}
```

---

## How to Submit

1. Go to the [WhatsApp Manager](https://business.facebook.com/wa/manage/message-templates/).
2. Click **Create Template**.
3. Select the Category (`Utility`) and Language (`French`).
4. Copy and paste the text from the `BODY`, `HEADER`, and `FOOTER` sections above.
5. Add the interactive buttons as defined in the `BUTTONS` section.
6. Provide the example values for the variables (e.g., "Monsieur Diop").
7. Submit for approval. Meta usually approves Utility templates within a few minutes.
