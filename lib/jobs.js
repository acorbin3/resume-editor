import { randomUUID } from "node:crypto";

// Long actions (convert, edit, analyze, apply) run as jobs that outlive the HTTP
// connection. The response streams events as before, but every event is also kept
// here so a client whose connection dropped (phone locked, app switched) can poll
// GET /api/jobs/:id and pick up the result. In-memory, per process; swap for a
// table or Redis if the app ever runs on more than one server.
const jobs = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

export function createJob(userId, resumeId, kind) {
  const job = { id: randomUUID(), userId, resumeId, kind, status: "running", events: [], result: null, createdAt: Date.now(), updatedAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}

export function recordEvent(job, evt) {
  job.updatedAt = Date.now();
  if (evt.type === "done") {
    job.status = "done";
    job.result = evt;
  } else if (evt.type === "error") {
    job.status = "error";
    job.result = evt;
  } else if (evt.type === "status" || evt.type === "created") {
    job.events.push(evt);
    if (job.events.length > 50) job.events.shift();
  }
}

export function getJob(userId, id) {
  const job = jobs.get(id);
  return job && job.userId === userId ? job : null;
}

// The most recent job still running for a resume (or, for conversions, for the user).
export function activeJob(userId, resumeId) {
  let best = null;
  for (const job of jobs.values()) {
    if (job.userId !== userId || job.status !== "running") continue;
    if (resumeId ? job.resumeId !== resumeId : job.kind !== "convert") continue;
    if (!best || job.createdAt > best.createdAt) best = job;
  }
  return best;
}

export function publicJob(job) {
  return { id: job.id, kind: job.kind, resumeId: job.resumeId, status: job.status, lastStatus: job.events.at(-1)?.message || null, result: job.result, startedAt: job.createdAt };
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) if (job.updatedAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();
