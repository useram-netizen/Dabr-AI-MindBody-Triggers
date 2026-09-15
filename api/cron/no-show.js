// api/cron/no-show.js
//
// Vercel Cron HTTP endpoint for the daily no-show detection job. Vercel
// Cron can only hit a URL on a schedule (it doesn't run raw scripts), so
// this is a thin wrapper around scheduled-jobs.js's runNoShowJob — the job
// logic itself lives entirely in that file and is untouched here.
//
// Configured in vercel.json to run daily; Vercel sends
// `Authorization: Bearer <CRON_SECRET>` automatically on cron-triggered
// requests, which we verify below so nobody else can trigger this job by
// guessing the URL.

const { runNoShowJob } = require("../../scheduled-jobs");

module.exports = async function handler(req, res) {
  const expectedAuthHeader = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || req.headers.authorization !== expectedAuthHeader) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    await runNoShowJob();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("No-show cron job failed:", error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
};
