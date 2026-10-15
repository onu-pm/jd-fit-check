// Vercel serverless function: POST /api/fetch-jd  { url }
// Reads a public job posting and returns its text. Same access rule as /api/analyze.

const dns = require("dns").promises;
const net = require("net");

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return null;
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateIp(a.address))) return null;
  } catch (e) { return null; }
  return u;
}

function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}

function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n").map(l => l.trim()).join("\n").trim();
}

function fromJsonLd(html) {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const raw = b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let data; try { data = JSON.parse(raw); } catch (e) { continue; }
    const list = Array.isArray(data) ? data : (data["@graph"] || [data]);
    for (const d of list) {
      if (d && /JobPosting/i.test(String(d["@type"])) && d.description) {
        const org = d.hiringOrganization && d.hiringOrganization.name;
        const loc = d.jobLocationType || (d.jobLocation && JSON.stringify(d.jobLocation).match(/"addressLocality":"([^"]+)"/)?.[1]) || "";
        return {
          title: [d.title, org].filter(Boolean).join(" at "),
          text: [loc ? "Location: " + loc : "", htmlToText(decode(String(d.description)))].filter(Boolean).join("\n\n")
        };
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const hasKey = String(req.headers["x-openrouter-key"] || "").trim().length > 10;
  const need = process.env.ACCESS_CODE;
  if (!hasKey && need && req.headers["x-access-code"] !== need) {
    res.status(401).json({ error: "Enter your API key or the access code first." }); return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const u = await safeUrl(String((body && body.url) || "").trim());
  if (!u) { res.status(400).json({ error: "That doesn't look like a public job posting link." }); return; }
  if (/linkedin\.com$/i.test(u.hostname) || /\.linkedin\.com$/i.test(u.hostname)) {
    res.status(422).json({ error: "LinkedIn blocks automated reading. Open the posting, copy the description and paste it below." }); return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u.toString(), {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JDFitCheck/1.0)", "Accept": "text/html,application/xhtml+xml" }
    });
    if (!r.ok) { res.status(422).json({ error: "The job site answered with an error (" + r.status + "). Paste the description instead." }); return; }
    const html = (await r.text()).slice(0, 2000000);
    const ld = fromJsonLd(html);
    let title = ld && ld.title, text = ld && ld.text;
    if (!text || text.length < 300) {
      const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = title || (t ? decode(t[1]).trim() : "");
      const main = html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<body[\s\S]*?<\/body>/i);
      text = htmlToText(main ? main[0] : html);
    }
    if (!text || text.length < 300) {
      res.status(422).json({ error: "This page loads the job with JavaScript, so it can't be read from here. Paste the description instead." }); return;
    }
    res.status(200).json({ title: title || "", text: text.slice(0, 20000) });
  } catch (e) {
    res.status(422).json({ error: "Couldn't load that page in time. Paste the description instead." });
  } finally { clearTimeout(timer); }
};
