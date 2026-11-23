// POST /api/lead
// Upserts a lead into the Notion "BagOps Leads" database.
// Env vars (set in Vercel, never sent to the browser): NOTION_TOKEN, NOTION_LEADS_DB_ID

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// The browser sends short keys; these are the labels stored in Notion.
const BUSINESS = { ecommerce: "Ecommerce", course: "Course or digital education", mastermind: "Mastermind or membership", other: "Other" };
const SPEND = { none: "Not running yet", under_5k: "Under $5k", "5k_20k": "$5k–$20k", "20k_50k": "$20k–$50k", "50k_plus": "$50k+" };
const BOTTLENECK = { creative: "Creative volume", performance: "ROAS or performance", tracking: "Tracking I can trust", repeat: "Repeat purchases" };
const QUALIFIED_SPEND = ["5k_20k", "20k_50k", "50k_plus"];

const PARTIAL = { 2: "Partial – Step 2", 3: "Partial – Step 3", 4: "Partial – Step 4" };
const STATUS_RANK = { "Partial – Step 2": 2, "Partial – Step 3": 3, "Partial – Step 4": 4, "Completed – Qualified": 5, "Completed – Unqualified": 5, "Guide viewed": 6, "Waitlist": 6 };
const MANUAL_STATUSES = ["Booked", "No-show", "Won", "Lost"]; // set by hand in Notion; never overwritten
// Joining the waitlist never overrides a hand-set status or a qualified lead.
const canWaitlist = (current) => !MANUAL_STATUSES.includes(current) && current !== "Completed – Qualified";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

// Best-effort rate limit: per IP, per warm function instance.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 30;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_REQUESTS;
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function cleanUrl(value) {
  let v = clean(value, 200);
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    return u.hostname.includes(".") ? u.toString() : "";
  } catch (e) {
    return "";
  }
}
function cleanInstagram(value) {
  const v = clean(value, 100).replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@+/, "").replace(/[/?#].*$/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v : "";
}

async function notion(path, method, body) {
  const res = await fetch(NOTION + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("Notion " + method + " " + path + " -> " + res.status + " " + (await res.text()).slice(0, 300));
  return res.json();
}
async function findOne(filter) {
  const out = await notion("/databases/" + process.env.NOTION_LEADS_DB_ID + "/query", "POST", {
    filter,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 1,
  });
  return out.results[0] || null;
}

const text = (v) => ({ rich_text: [{ text: { content: v } }] });

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ ok: false });

  // sendBeacon can deliver the body as a string.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false });

  // Honeypot: pretend it worked, store nothing.
  if (clean(body.company, 100)) return res.status(200).json({ ok: true });

  const sessionId = clean(body.session_id, 64);
  if (!SESSION_RE.test(sessionId)) return res.status(400).json({ ok: false });

  if (!process.env.NOTION_TOKEN || !process.env.NOTION_LEADS_DB_ID) {
    console.error("lead: NOTION_TOKEN or NOTION_LEADS_DB_ID is not set");
    return res.status(500).json({ ok: false });
  }

  // Checklist page opened from the form's "early" screen (?sid=...): mark the lead, nothing else.
  // Only a lead sitting at "Completed – Unqualified" is changed; every other status is left alone.
  if (body.event === "guide_view") {
    try {
      const lead = await findOne({ property: "Session ID", rich_text: { equals: sessionId } });
      const current = lead && lead.properties["Status"] && lead.properties["Status"].select ? lead.properties["Status"].select.name : "";
      if (lead && current === "Completed – Unqualified") {
        await notion("/pages/" + lead.id, "PATCH", {
          properties: { Status: { select: { name: "Guide viewed" } }, "Last Updated": { date: { start: new Date().toISOString() } } },
        });
      }
      // "known" tells the page whether this id belongs to a real lead (if not, it asks for an email).
      return res.status(200).json({ ok: true, known: !!lead });
    } catch (err) {
      console.error("lead:", err && err.message ? err.message : err);
      return res.status(500).json({ ok: false });
    }
  }

  // Checklist page: one-click waitlist join for a lead already on file (from the form or the email gate).
  if (body.event === "waitlist_join") {
    try {
      const lead = await findOne({ property: "Session ID", rich_text: { equals: sessionId } });
      const current = lead && lead.properties["Status"] && lead.properties["Status"].select ? lead.properties["Status"].select.name : "";
      if (lead && canWaitlist(current)) {
        await notion("/pages/" + lead.id, "PATCH", {
          properties: { Status: { select: { name: "Waitlist" } }, "Last Updated": { date: { start: new Date().toISOString() } } },
        });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("lead:", err && err.message ? err.message : err);
      return res.status(500).json({ ok: false });
    }
  }

  const email = clean(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false });

  // Email gate on the checklist page (direct traffic, not the qualifying form).
  const fromChecklist = body.source === "checklist";

  const lastStep = Math.min(5, Math.max(2, parseInt(body.last_step, 10) || 2));
  const firstName = clean(body.first_name, 80);
  const business = BUSINESS[body.business_type] ? body.business_type : "";
  const spend = SPEND[body.meta_spend] ? body.meta_spend : "";
  const bottleneck = BOTTLENECK[body.bottleneck] ? body.bottleneck : "";
  const website = cleanUrl(body.website);
  const instagram = cleanInstagram(body.instagram);

  // Status and Qualified are decided here, not by the browser.
  const qualified = QUALIFIED_SPEND.includes(spend);
  const status = lastStep >= 5 ? (qualified ? "Completed – Qualified" : "Completed – Unqualified") : PARTIAL[lastStep];

  try {
    const now = new Date().toISOString();

    // Same session first; otherwise an earlier lead with the same email.
    const page =
      (await findOne({ property: "Session ID", rich_text: { equals: sessionId } })) ||
      (await findOne({ property: "Email", email: { equals: email } }));

    const props = {
      Name: { title: [{ text: { content: firstName || email } }] },
      Email: { email },
      "Session ID": text(sessionId),
      "Last Updated": { date: { start: now } },
    };
    if (business) props["Business Type"] = { select: { name: BUSINESS[business] } };
    if (spend) {
      props["Meta Spend"] = { select: { name: SPEND[spend] } };
      props["Qualified"] = { checkbox: qualified };
    }
    if (bottleneck) props["Bottleneck"] = { select: { name: BOTTLENECK[bottleneck] } };
    if (website) props["Website"] = { url: website };
    if (instagram) props["Instagram"] = text(instagram);

    if (page) {
      const current = page.properties["Status"] && page.properties["Status"].select ? page.properties["Status"].select.name : "";
      const currentStep = (page.properties["Last Step"] && page.properties["Last Step"].number) || 0;
      // Never move a lead backwards, and never touch a status set by hand.
      if (fromChecklist) {
        // An existing lead keeps its status; only a row with none gets the opt-in label.
        if (!current) props["Status"] = { select: { name: "Guide – Opt-in" } };
      } else {
        if (!MANUAL_STATUSES.includes(current) && lastStep >= (STATUS_RANK[current] || 0)) {
          props["Status"] = { select: { name: status } };
        }
        props["Last Step"] = { number: Math.max(currentStep, lastStep) };
      }
      await notion("/pages/" + page.id, "PATCH", { properties: props });
    } else {
      props["Status"] = { select: { name: fromChecklist ? "Guide – Opt-in" : status } };
      if (!fromChecklist) props["Last Step"] = { number: lastStep };
      props["First Seen"] = { date: { start: now } };
      // Source is recorded once, when the lead is first created.
      const utm = { "UTM Source": body.utm_source, "UTM Medium": body.utm_medium, "UTM Campaign": body.utm_campaign, "UTM Content": body.utm_content };
      for (const key of Object.keys(utm)) {
        const v = clean(utm[key], 150);
        if (v) props[key] = text(v);
      }
      const referrer = clean(body.referrer, 300);
      if (referrer) props["Referrer"] = text(referrer);
      await notion("/pages", "POST", { parent: { database_id: process.env.NOTION_LEADS_DB_ID }, properties: props });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("lead:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false });
  }
};
