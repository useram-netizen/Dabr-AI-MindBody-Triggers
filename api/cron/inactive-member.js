// api/cron/inactive-member.js
//
// Vercel Cron HTTP endpoint for the inactive-member detection job. Same
// pattern as api/cron/no-show.js — a thin wrapper around scheduled-jobs.js's
// runInactiveMemberJob, whose logic is untouched here.
//
// Configured in vercel.json to run daily; Vercel sends
// `Authorization: Bearer <CRON_SECRET>` automatically on cron-triggered
// requests, which we verify below so nobody else can trigger this job by
// guessing the URL.

const { runInactiveMemberJob } = require("../../scheduled-jobs");

module.exports = async function handler(req, res) {
  const expectedAuthHeader = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || req.headers.authorization !== expectedAuthHeader) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    await runInactiveMemberJob();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Inactive-member cron job failed:", error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
