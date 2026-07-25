// chatbot.js
// Powers the on-site chat widget using Google's Gemini API — same plain-
// fetch pattern as razorpay.js and mailer.js, no SDK dependency.
//
// SETUP:
// 1. Go to https://aistudio.google.com/app/apikey and click "Create API key".
//    No credit card needed — Gemini's free tier works with just a Google
//    account and stays free (Flash / Flash-Lite models) unless you later
//    turn on billing yourself.
// 2. Set GEMINI_API_KEY in your .env to that key.
// 3. (Optional) Set GEMINI_MODEL in .env to pick a different model. Defaults
//    to 'gemini-2.5-flash-lite', the fastest/most-generous free-tier model.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

// Builds the instructions the model follows every reply. Pulling live
// art types / sizes / services out of the database (rather than hardcoding
// them) means the chatbot never goes stale when the admin edits those.
function buildSystemPrompt({ artTypes, sizes, services }) {
  const typesList = (artTypes || []).join(', ');
  const sizesList = (sizes || []).join(', ');
  const servicesList = (services || []).map(s => `- ${s.name}`).join('\n');

  return `You are the friendly customer-support chat assistant for Kishor Kanna Arts, a custom hand-drawn art studio.
Speak in simple, warm, everyday language. Keep replies short (2-4 sentences) unless the customer clearly wants more detail.
Never use Markdown, links, or URLs of any kind in your replies — no [text](url), no bare http/https links, no asterisks for bold. Plain sentences only. When you mention a page, just say its name in plain text (e.g. "check the Services page") — never its address.

You help with two things:
1. General questions about the site, art styles, and how ordering works.
2. Walking a customer step by step through placing a custom order.

Facts you can rely on:
- Art types offered: ${typesList || 'various styles — point them to the Services page'}
- Sizes offered: ${sizesList || 'A5, A4, A3, A2, Custom'}
- Services:
${servicesList || '(see the Services page for the current list)'}

How ordering actually works on this site (describe only this — never invent a different flow):
- Browse the Services page and Portfolio page for inspiration.
- Place an order from the order page, upload a reference photo, choose size, and pay via Razorpay.
- Track an existing order anytime on the Track Order page using the order code.
- For exact prices, delivery timelines, or anything you're unsure of, tell them to check the Services page or reach out via the Contact page — never guess or make up a number.`;
}
// messages: [{ role: 'user'|'assistant', content: string }, ...]
// context: { artTypes, sizes, services, siteUrl }
async function chat(messages, context) {
  if (!isConfigured()) {
    throw new Error('GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey and add it to .env');
  }

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(context) }] },
      contents,
      generationConfig: { maxOutputTokens: 400, temperature: 0.6 }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const reply = (data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts || [])
    .map(p => p.text).join('').trim();
  if (!reply) throw new Error('Gemini returned an empty reply.');
  return reply;
}

module.exports = { chat, isConfigured, buildSystemPrompt };
