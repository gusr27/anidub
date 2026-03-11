// api/feedback.js — handles bug reports, show revisions, and general comments
// Bug reports + revisions → Linear issue
// Comments / questions → Resend email
// All types → Supabase submissions log

const LINEAR_API    = "https://api.linear.app/graphql";
const RESEND_API    = "https://api.resend.com/emails";
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role key (not anon)

// ── Linear ────────────────────────────────────────────────────────────────────
async function createLinearIssue({ title, description, labelName }) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY not set");

  console.log("[Linear] API key present, length:", apiKey.length);
  console.log("[Linear] Key prefix:", apiKey.slice(0, 8));

  const headers = {
    "Content-Type": "application/json",
    Authorization: apiKey,
  };

  // Single query: fetch team + labels in one round-trip
  const bootstrapRes = await fetch(LINEAR_API, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `{
        teams { nodes { id name } }
        issueLabels { nodes { id name team { id } } }
      }`,
    }),
  });

  console.log("[Linear] Bootstrap status:", bootstrapRes.status);
  const bootstrap = await bootstrapRes.json();
  console.log("[Linear] Bootstrap response:", JSON.stringify(bootstrap));

  if (bootstrap.errors) {
    throw new Error("Linear auth/query failed: " + JSON.stringify(bootstrap.errors));
  }

  const team = bootstrap?.data?.teams?.nodes?.[0];
  if (!team) throw new Error("No Linear team found — check your API key has access");
  console.log("[Linear] Team:", team.id, team.name);

  const label = bootstrap?.data?.issueLabels?.nodes?.find(
    l => l.name.toLowerCase() === labelName.toLowerCase() && l.team?.id === team.id
  );
  console.log("[Linear] Label lookup for", labelName, "→", label ? label.id : "not found");

  // Create the issue
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
      }
    }
  `;

  const input = {
    teamId: team.id,
    title,
    description,
    ...(label ? { labelIds: [label.id] } : {}),
  };

  console.log("[Linear] Creating issue with input:", JSON.stringify(input));

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: mutation, variables: { input } }),
  });

  console.log("[Linear] Create status:", res.status);
  const data = await res.json();
  console.log("[Linear] Create response:", JSON.stringify(data));

  if (data.errors) {
    throw new Error("Linear mutation failed: " + JSON.stringify(data.errors));
  }
  if (!data?.data?.issueCreate?.success) {
    throw new Error("Linear issueCreate returned success=false");
  }

  return data.data.issueCreate.issue;
}

// ── Resend ────────────────────────────────────────────────────────────────────
async function sendEmail({ subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const toEmail    = process.env.FEEDBACK_TO_EMAIL;    // your email
  const fromEmail  = process.env.FEEDBACK_FROM_EMAIL;  // e.g. feedback@yourdomain.com

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: fromEmail || "AnimeDUB Feedback <onboarding@resend.dev>",
      to: [toEmail],
      reply_to: replyTo || undefined,
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("Resend error: " + data.error.message);
  return data;
}

// ── Supabase log ──────────────────────────────────────────────────────────────
async function logSubmission(row) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return; // soft fail if not configured
  await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

// ── Format helpers ────────────────────────────────────────────────────────────
function bugReportMarkdown(fields) {
  return [
    `## Bug Report`,
    `**Submitted:** ${new Date().toUTCString()}`,
    fields.email ? `**Reporter:** ${fields.email}` : "",
    ``,
    `### Description`,
    fields.description || "_No description provided_",
    ``,
    `### Steps to Reproduce`,
    fields.steps || "_Not provided_",
    ``,
    `### Expected Behaviour`,
    fields.expected || "_Not provided_",
    ``,
    `### Device / Browser`,
    fields.device || "_Not provided_",
  ].filter(l => l !== undefined).join("\n");
}

function revisionMarkdown(fields) {
  return [
    `## Show ${fields.revisionType === "addition" ? "Addition" : "Revision"} Request`,
    `**Submitted:** ${new Date().toUTCString()}`,
    fields.email ? `**Reporter:** ${fields.email}` : "",
    ``,
    `### Show`,
    fields.showName || "_Not specified_",
    ``,
    `### Request`,
    fields.requestDetail || "_No details provided_",
    ``,
    ...(fields.currentStatus  ? [`**Current dub status:** ${fields.currentStatus}`]  : []),
    ...(fields.correctStatus  ? [`**Correct dub status:** ${fields.correctStatus}`]  : []),
    ...(fields.streamingLinks ? [`**Streaming links:** ${fields.streamingLinks}`]    : []),
    ...(fields.sourceUrl      ? [`**Source / reference:** ${fields.sourceUrl}`]      : []),
  ].join("\n");
}

function commentHtml(fields) {
  return `
    <div style="font-family:sans-serif;max-width:600px">
      <h2 style="color:#dc2626">AnimeDUB — ${fields.type === "question" ? "Question" : "Comment"}</h2>
      <p><strong>From:</strong> ${fields.email || "Anonymous"}</p>
      <p><strong>Date:</strong> ${new Date().toUTCString()}</p>
      <hr/>
      <p style="white-space:pre-wrap">${(fields.message || "").replace(/</g, "&lt;")}</p>
    </div>
  `;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const fields = req.body;
  const { type } = fields;

  if (!type) return res.status(400).json({ error: "Missing type field" });

  try {
    let linearIssue = null;

    if (type === "bug") {
      const title = `[Bug] ${(fields.description || "").slice(0, 80)}`;
      linearIssue = await createLinearIssue({
        title,
        description: bugReportMarkdown(fields),
        labelName: "Bug",
      });
      // Also email if reporter left their email
      if (fields.email) {
        await sendEmail({
          subject: `[AnimeDUB] Bug report received — ${linearIssue.identifier}`,
          replyTo: fields.email,
          html: `<p>Thanks for the report! We've logged it as <strong>${linearIssue.identifier}</strong>. We'll look into it shortly.</p>`,
        }).catch(() => {}); // non-fatal
      }
    }

    else if (type === "revision") {
      const action = fields.revisionType === "addition" ? "Add" : "Revise";
      const title  = `[Show ${action}] ${fields.showName || "Unknown show"}`;
      linearIssue = await createLinearIssue({
        title,
        description: revisionMarkdown(fields),
        labelName: fields.revisionType === "addition" ? "Show Addition" : "Show Revision",
      });
      if (fields.email) {
        await sendEmail({
          subject: `[AnimeDUB] Show request received — ${linearIssue.identifier}`,
          replyTo: fields.email,
          html: `<p>Thanks! Your request for <strong>${fields.showName}</strong> has been logged as <strong>${linearIssue.identifier}</strong>.</p>`,
        }).catch(() => {});
      }
    }

    else if (type === "comment" || type === "question") {
      await sendEmail({
        subject: `[AnimeDUB] ${type === "question" ? "Question" : "Comment"} from ${fields.email || "Anonymous"}`,
        replyTo: fields.email || undefined,
        html: commentHtml(fields),
      });
    }

    else {
      return res.status(400).json({ error: `Unknown submission type: ${type}` });
    }

    // Log everything to Supabase regardless of type
    await logSubmission({
      type,
      email: fields.email || null,
      payload: fields,
      linear_issue_id:  linearIssue?.id         || null,
      linear_issue_url: linearIssue?.url         || null,
      linear_identifier: linearIssue?.identifier || null,
    }).catch(() => {}); // non-fatal

    return res.status(200).json({
      ok: true,
      ...(linearIssue ? { issueId: linearIssue.identifier, issueUrl: linearIssue.url } : {}),
    });

  } catch (err) {
    console.error("Feedback handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}