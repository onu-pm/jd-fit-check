// Vercel serverless function: POST /api/analyze
// Key: the visitor's own OpenRouter key (x-openrouter-key header) is used when sent.
// Otherwise the site's key (env OPENROUTER_API_KEY) is used, and ACCESS_CODE (if set) must match.
// Env vars: OPENROUTER_API_KEY, ACCESS_CODE, MODEL (all optional). Keys are never logged or stored.

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

function buildPrompt(jd, resume, notes) {
  return `You are a hiring-side reviewer helping a product manager tailor his resume to one job. Compare the RESUME with the JOB DESCRIPTION and say exactly what to change.

Hard rules:
1. Never invent experience, employers, tools, metrics or numbers. Rewrites may only reword, reorder or re-emphasize facts already in the RESUME. Facts in NOTES are true but not on the resume: suggest adding one only when it directly matches the JD, and set its source to "notes".
2. If the JD wants something neither the resume nor the notes show, it is a gap. List it in "gaps". Never write it into a bullet or into skills_add.
3. Every rewritten bullet uses Google's X-Y-Z shape: "Accomplished X as measured by Y by doing Z". One sentence, at most 35 words, plain words a person would say. No lists in parentheses, no em dashes, and none of: leveraged, spearheaded, seamless, robust, cutting-edge, synergy, utilize.
4. Where the resume already has a fact, reuse the JD's exact wording for it so a keyword screen matches.
5. Keep every number exactly as written in the resume.
6. Be direct. If the role is a poor fit, say so.

Scoring, each 0-100:
- skills: hard skills, tools and domain knowledge the JD names
- responsibilities: how well the resume shows the day-to-day work the JD describes
- seniority: years and level against what the JD asks. Count years from the resume's dates; use NOTES for total experience.
- title: how close the resume's title and focus are to the JD's title and team

Reply with only this JSON, no other text:
{
  "role": "job title and company if stated, else job title",
  "verdict": "one or two sentences on overall fit and the single most important change",
  "scores": {"skills": 0, "responsibilities": 0, "seniority": 0, "title": 0},
  "score_notes": {"skills": "one short line", "responsibilities": "one short line", "seniority": "one short line", "title": "one short line"},
  "knockouts": ["hard requirements the resume doesn't show, such as minimum years, location, work authorization, a language, a degree or a named tool. Empty array if none"],
  "keywords": [{"term": "a JD term an ATS or recruiter would screen for", "status": "present | reword | gap", "importance": "must | nice", "note": "present: where it appears. reword: which resume wording to change and to what. gap: what is missing"}],
  "skills_matched": [{"jd": "skill as the JD says it", "resume": "the resume's wording for the same skill", "where": "Skills | Summary | Bullet N"}],
  "tailor_actions": [{"priority": "high | medium | low", "where": "Summary | Bullets | Skills | Title line | Order | Other", "action": "short imperative instruction", "detail": "the exact words to add or change", "source": "resume | notes"}],
  "bullet_edits": [{"current": "the first 10 words of the existing resume bullet, copied exactly", "suggested": "the full rewritten bullet", "why": "one short line on which JD need it now hits"}],
  "bullet_order": "which existing bullets to move to the top for this JD, and why, in one or two sentences",
  "summary_suggested": "a rewritten 2-3 sentence summary aimed at this JD, true to the resume",
  "summary_why": "one short line",
  "skills_add": ["skills to add to the Skills section that the resume or notes already prove, in the JD's wording"],
  "skills_reorder": "which skills line to put first and what to move up, one sentence",
  "gaps": [{"gap": "what the JD wants that you can't show", "how": "how to handle it: cover letter, interview story, or add only if true"}]
}

Give 12 to 20 keywords, most important first. Give 6 to 10 tailor_actions, highest priority first; they are the checklist the candidate works through in Word, so make each one concrete. Give at most 5 bullet_edits; only rewrite a bullet when the change clearly improves the match.

JOB DESCRIPTION:
"""
${jd}
"""

RESUME:
"""
${resume}
"""

NOTES (true, not on the resume):
"""
${notes}
"""`;
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const userKey = String(req.headers["x-openrouter-key"] || "").trim();
  let apiKey = userKey;
  if (!apiKey) {
    const need = process.env.ACCESS_CODE;
    if (need && req.headers["x-access-code"] !== need) {
      res.status(401).json({ error: "Enter your OpenRouter API key, or the site's access code, in the settings above." }); return;
    }
    apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) { res.status(401).json({ error: "No API key. Paste your OpenRouter key in the settings above." }); return; }
  }
  const model = String(req.headers["x-model"] || "").trim().slice(0, 120) || process.env.MODEL || DEFAULT_MODEL;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const jd = String((body && body.jd) || "").slice(0, 20000);
  const resume = String((body && body.resume) || "").slice(0, 12000);
  const notes = String((body && body.notes) || "").slice(0, 4000);
  if (jd.length < 200 || resume.length < 200) {
    res.status(400).json({ error: "Send both a full job description and a resume." }); return;
  }

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://" + (req.headers.host || "jd-fit-check.vercel.app"),
        "X-Title": "JD Fit Check"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 6000,
        messages: [{ role: "user", content: buildPrompt(jd, resume, notes) }]
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("Model request failed (" + r.status + ").");
      if (r.status === 401) { res.status(401).json({ error: "OpenRouter rejected the API key. Paste a valid key in the settings above." }); return; }
      if (r.status === 402) { res.status(402).json({ error: "This OpenRouter key is out of credit. Add credit or switch to another key." }); return; }
      res.status(502).json({ error: "The AI model returned an error (" + model + "): " + msg }); return;
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "";
    const parsed = extractJson(text);
    if (!parsed) { res.status(502).json({ error: "The report came back in a broken format. Press Check fit to try again." }); return; }
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: "Couldn't reach the AI model. Try again in a minute." });
  }
};
